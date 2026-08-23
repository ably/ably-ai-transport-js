/**
 * Client-side steer state machine.
 *
 * Owns every piece of state involved in the `session.view.send(...)` →
 * `run.steer(...)` → lifecycle-event lifecycle:
 *   - {@link _pendingEchoes} — steers awaiting their own channel echo (so
 *     the SDK can read the Ably-assigned publish serial and surface it via
 *     `published`).
 *   - {@link _inflightSteers} — outcome handlers awaiting a lifecycle
 *     event on the targeted Run.
 *   - {@link _consumedByRunId} — accumulator of `steer-codec-message-ids`
 *     stamps observed on the Run's response messages.
 *   - {@link _deadRunIds} — runs whose `run-end` the SDK has folded;
 *     subsequent `steer()` calls reject synchronously.
 *
 * Hosting sessions wire it up by:
 *   1. constructing it with a publish callback, a clientId resolver, and
 *      a closed predicate;
 *   2. calling `observeMessage(msg)` from their channel listener for every
 *      inbound message;
 *   3. exposing `steer(runIdPromise, input)` as the {@link ClientRun.steer}
 *      method;
 *   4. calling `drainContinuityLost(err)` on a channel discontinuity;
 *   5. calling `drainClosed()` on session close.
 */

import * as Ably from 'ably';

import {
  EVENT_RUN_END,
  EVENT_RUN_SUSPEND,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STEER_CODEC_MESSAGE_IDS,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage, getTransportHeaders } from '../../utils.js';
import type { WriteOptions } from '../codec/types.js';
import { buildTransportHeaders } from './headers.js';
import type { RunEndReason } from './types/shared.js';
import type { SteerOutcome, SteerResult } from './types/steer.js';

/** Constructor options for {@link SteerCoordinator}. */
export interface SteerCoordinatorOptions<TInput> {
  /**
   * Publish a steer input on the channel. Wraps the session-level
   * `Encoder<TInput, _>.publishInput` so the coordinator does not need
   * to know about TOutput.
   */
  publish: (input: TInput, opts: WriteOptions) => Promise<void>;
  /**
   * Resolve the publisher's `clientId` at publish time. Stamped on each
   * steer's `run-client-id` header.
   */
  clientId: () => string | undefined;
  /**
   * Whether the hosting session is closed. Checked once after the
   * `runIdPromise` resolves so a session-close-during-await rejects
   * cleanly instead of publishing into a dead session.
   */
  isSessionClosed: () => boolean;
  /** Logger for malformed-header / parse-failure warnings. */
  logger: Logger;
}

/**
 * In-flight steer awaiting a lifecycle event on its target run. Stored in
 * {@link SteerCoordinator}'s per-runId bucket.
 */
interface InflightSteer {
  /** The steer's codec-message-id; matched against the accumulated consumed set. */
  steerCodecMessageId: string;
  /** Resolve the outcome promise (called on every lifecycle event the entry survives to). */
  resolve: (outcome: SteerOutcome) => void;
  /** Reject the outcome promise (continuity loss, session close). */
  reject: (e: Ably.ErrorInfo) => void;
}

/**
 * Pending steer awaiting its own channel echo. Keyed by the
 * client-minted codec-message-id stamped on the publish; the matching
 * inbound message carries it back as `codec-message-id`.
 */
interface PendingSteerEcho {
  /** The agent-minted run-id the steer is targeting. */
  runId: string;
  /** Resolve `published` with the publish's Ably-assigned serial. */
  resolvePublished: (value: { serial: string | undefined }) => void;
  /** Resolve the outcome (used by the run-end drain when the echo never landed). */
  resolveOutcome: (outcome: SteerOutcome) => void;
  /** Reject the outcome (continuity loss, session close). */
  rejectOutcome: (e: Ably.ErrorInfo) => void;
}

/**
 * Owns the client-side steer lifecycle for one {@link ClientSession}. See the
 * module doc for the state it holds and how a session wires it in.
 * @template TInput - The codec's input event type.
 */
export class SteerCoordinator<TInput> {
  private readonly _publish: (input: TInput, opts: WriteOptions) => Promise<void>;
  private readonly _clientId: () => string | undefined;
  private readonly _isSessionClosed: () => boolean;
  private readonly _logger: Logger;

  /** In-flight steer outcomes awaiting resolution, keyed by run-id. */
  private readonly _inflightSteers = new Map<string, InflightSteer[]>();

  /**
   * Per-run union of codec-message-ids the agent has stamped as consumed on
   * its response messages (`steer-codec-message-ids` header). Cleared on
   * `run-end` after resolving the matching in-flight bucket, and on close.
   */
  private readonly _consumedByRunId = new Map<string, Set<string>>();

  /** Steers awaiting their own channel echo, keyed by codec-message-id. */
  private readonly _pendingEchoes = new Map<string, PendingSteerEcho>();

  /**
   * Run-ids the SDK has observed a `run-end` for. Subsequent `steer()`
   * calls targeting these reject synchronously without publishing.
   */
  private readonly _deadRunIds = new Set<string>();

  constructor(options: SteerCoordinatorOptions<TInput>) {
    this._publish = options.publish;
    this._clientId = options.clientId;
    this._isSessionClosed = options.isSessionClosed;
    this._logger = options.logger.withContext({ component: 'SteerCoordinator' });
  }

  /**
   * Publish a steering user-message targeting `runId`. Awaits the caller's
   * `runIdPromise` so a steer attempted before `ai-run-start` lands is
   * delayed (not rejected) until the agent has minted the id. Registers a
   * pending-echo entry keyed by the steer's codec-message-id; when the
   * channel delivers the echo via {@link observeMessage}, the coordinator
   * resolves `published` with the Ably-assigned serial and moves the
   * outcome handler to `_inflightSteers` under the resolved `runId`.
   *
   * Dead-handle: if the SDK has already folded a `run-end` for the run
   * (recorded in {@link _deadRunIds}), or if `runIdPromise` rejects, both
   * returned promises reject without any channel publish.
   * @param runIdPromise - The handle's `runId` promise (may be unresolved).
   * @param input - The codec input event to publish, in the codec's input shape.
   * @returns The {@link SteerResult} pair.
   */
  steer(runIdPromise: Promise<string>, input: TInput): SteerResult {
    // Build the published/outcome promise pair up front so we can return
    // them synchronously. The publish lifecycle runs in an async IIFE
    // below; `published`'s serial only resolves once we observe the
    // channel echo of our own publish.
    let resolvePublished!: (value: { serial: string | undefined }) => void;
    let rejectPublished!: (e: Ably.ErrorInfo) => void;
    let resolveOutcome!: (outcome: SteerOutcome) => void;
    let rejectOutcome!: (e: Ably.ErrorInfo) => void;
    const published = new Promise<{ serial: string | undefined }>((res, rej) => {
      resolvePublished = res;
      rejectPublished = rej;
    });
    const outcome = new Promise<SteerOutcome>((res, rej) => {
      resolveOutcome = res;
      rejectOutcome = rej;
    });
    // Suppress unhandled-rejection warnings for callers that only await one.
    published.catch(() => {
      /* observed via published, if at all */
    });
    outcome.catch(() => {
      /* observed via outcome, if at all */
    });

    // Fire-and-forget: the publish lifecycle drives the returned promises; the
    // caller observes them, so nothing here is awaited at the call site.
    void (async () => {
      let resolvedRunId: string;
      try {
        resolvedRunId = await runIdPromise;
      } catch (error) {
        const errInfo =
          error instanceof Ably.ErrorInfo
            ? error
            : new Ably.ErrorInfo(
                `unable to steer; runId never resolved: ${errorMessage(error)}`,
                ErrorCode.InvalidArgument,
                400,
                errorCause(error),
              );
        rejectPublished(errInfo);
        rejectOutcome(errInfo);
        return;
      }

      // Dead-handle: refuse to publish into a Run we've already folded
      // `run-end` for.
      if (this._deadRunIds.has(resolvedRunId)) {
        const err = new Ably.ErrorInfo(
          `unable to steer; run ${resolvedRunId} has already ended`,
          ErrorCode.InvalidArgument,
          400,
        );
        rejectPublished(err);
        rejectOutcome(err);
        return;
      }

      if (this._isSessionClosed()) {
        const err = new Ably.ErrorInfo('unable to steer; session is closed', ErrorCode.SessionClosed, 400);
        rejectPublished(err);
        rejectOutcome(err);
        return;
      }

      const codecMessageId = crypto.randomUUID();
      const inputEventId = crypto.randomUUID();
      const headers = buildTransportHeaders({
        role: 'user',
        runId: resolvedRunId,
        codecMessageId,
        runClientId: this._clientId(),
        inputEventId,
      });

      // Register the pending-echo entry BEFORE publishing so the channel
      // delivery (which races publish completion) finds it.
      this._pendingEchoes.set(codecMessageId, {
        runId: resolvedRunId,
        resolvePublished,
        resolveOutcome,
        rejectOutcome,
      });

      // The steer publishes on `ai-input` with the `run-id` header set,
      // which the Tree routes into the addressed Run's projection via
      // `_applyRunMessage`. Callers pass the same shape `view.send` accepts
      // (typically `codec.createUserMessage(...)`).
      try {
        await this._publish(input, { extras: { headers }, messageId: codecMessageId });
      } catch (error) {
        // Publish failed — pull the pending-echo entry and reject both
        // promises. The channel never observed the publish, so the echo
        // path will never fire for this codec-message-id.
        this._pendingEchoes.delete(codecMessageId);
        const cause = errorCause(error);
        const isPermission = cause?.statusCode === 401 || cause?.statusCode === 403;
        const err = new Ably.ErrorInfo(
          isPermission
            ? `unable to publish steer; missing publish capability on the channel`
            : `unable to publish steer; ${errorMessage(error)}`,
          isPermission ? ErrorCode.InsufficientCapability : ErrorCode.SessionSendFailed,
          isPermission ? 401 : 500,
          cause,
        );
        rejectPublished(err);
        rejectOutcome(err);
      }
    })();

    return { published, outcome };
  }

  /**
   * Process an inbound channel message. The coordinator inspects three
   * orthogonal facets:
   *   1. Echo match — if the message's codec-message-id matches a pending
   *      steer publish, resolve `published` with the Ably-assigned serial
   *      and move the outcome handler into `_inflightSteers`.
   *   2. Stamp accumulation — if the message carries
   *      `steer-codec-message-ids`, union the listed ids into the run's
   *      consumed set.
   *   3. Lifecycle resolution — on `ai-run-suspend` / `ai-run-end`,
   *      resolve in-flight outcomes for the run by membership.
   * @param msg - The inbound Ably message just delivered to the channel.
   */
  observeMessage(msg: Ably.InboundMessage): void {
    const headers = getTransportHeaders(msg);

    // (1) Echo match: this inbound is our own steer's channel delivery.
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    if (codecMessageId !== undefined) {
      const pending = this._pendingEchoes.get(codecMessageId);
      if (pending) {
        this._pendingEchoes.delete(codecMessageId);
        pending.resolvePublished({ serial: msg.serial });
        // Register the outcome handler on the resolved run-id's bucket.
        // The next `run-suspend`/`run-end` for this run will resolve it by
        // checking whether `steerCodecMessageId` is in the consumed set.
        const entry: InflightSteer = {
          steerCodecMessageId: codecMessageId,
          resolve: pending.resolveOutcome,
          reject: pending.rejectOutcome,
        };
        const bucket = this._inflightSteers.get(pending.runId);
        if (bucket === undefined) this._inflightSteers.set(pending.runId, [entry]);
        else bucket.push(entry);
      }
    }

    // (2) Stamp accumulation: union the `steer-codec-message-ids` delta
    // for the run. Lifecycle events do NOT carry this header in the agent
    // implementation, but the parse is gated on its presence so an
    // accidental stamp would just be a harmless union.
    const runIdHeader = headers[HEADER_RUN_ID];
    const steerIdsStamp = headers[HEADER_STEER_CODEC_MESSAGE_IDS];
    if (runIdHeader !== undefined && steerIdsStamp !== undefined) {
      try {
        // CAST: trust boundary — the agent always stamps a JSON array of
        // strings; malformed input degrades to "no consumption" for the
        // affected message.
        const parsed = JSON.parse(steerIdsStamp) as unknown;
        if (Array.isArray(parsed)) {
          let bucket = this._consumedByRunId.get(runIdHeader);
          if (bucket === undefined) {
            bucket = new Set<string>();
            this._consumedByRunId.set(runIdHeader, bucket);
          }
          for (const id of parsed) if (typeof id === 'string') bucket.add(id);
        } else {
          this._logger.warn('SteerCoordinator.observeMessage(); ignoring non-array steer-codec-message-ids', {
            runId: runIdHeader,
          });
        }
      } catch (error) {
        this._logger.warn('SteerCoordinator.observeMessage(); failed to parse steer-codec-message-ids', {
          runId: runIdHeader,
          error: errorMessage(error),
        });
      }
    }

    // (3) Lifecycle resolution.
    if (msg.name === EVENT_RUN_SUSPEND || msg.name === EVENT_RUN_END) {
      const lifecycleRunId = headers[HEADER_RUN_ID];
      if (lifecycleRunId !== undefined) {
        const isEnd = msg.name === EVENT_RUN_END;
        const terminalReason = isEnd
          ? // CAST: agent always writes a valid RunEndReason; default to 'complete' for robustness
            ((headers[HEADER_RUN_REASON] ?? 'complete') as RunEndReason)
          : undefined;
        this._resolveOutcomes(lifecycleRunId, isEnd, terminalReason);
      }
    }
  }

  /**
   * Drain every in-flight bucket and pending-echo entry on channel
   * continuity loss. Post-loss the channel will not deliver the steer
   * echoes or run-end lifecycle events that would have resolved these
   * promises, so they would otherwise hang until close().
   * @param err - The continuity-loss error to reject outcomes with.
   */
  drainContinuityLost(err: Ably.ErrorInfo): void {
    for (const bucket of this._inflightSteers.values()) {
      for (const entry of bucket) entry.reject(err);
    }
    this._inflightSteers.clear();
    for (const entry of this._pendingEchoes.values()) {
      entry.resolvePublished({ serial: undefined });
      entry.rejectOutcome(err);
    }
    this._pendingEchoes.clear();
    this._deadRunIds.clear();
    this._consumedByRunId.clear();
  }

  /**
   * Drain on session close. Rejects any in-flight outcomes and pending
   * echoes so callers awaiting them settle rather than hang. Steers whose
   * `published` already resolved still see their `outcome` promise reject
   * here.
   */
  drainClosed(): void {
    if (this._inflightSteers.size > 0) {
      const closedErr = new Ably.ErrorInfo(
        'unable to await steer outcome; session closed',
        ErrorCode.SessionClosed,
        400,
      );
      for (const bucket of this._inflightSteers.values()) {
        for (const entry of bucket) entry.reject(closedErr);
      }
      this._inflightSteers.clear();
    }
    if (this._pendingEchoes.size > 0) {
      const echoClosedErr = new Ably.ErrorInfo(
        'unable to await steer publish; session closed',
        ErrorCode.SessionClosed,
        400,
      );
      for (const entry of this._pendingEchoes.values()) {
        entry.resolvePublished({ serial: undefined });
        entry.rejectOutcome(echoClosedErr);
      }
      this._pendingEchoes.clear();
    }
    this._deadRunIds.clear();
    this._consumedByRunId.clear();
  }

  /**
   * Resolve in-flight steer outcomes for `runId` on a `run-suspend` /
   * `run-end` lifecycle event by membership against the accumulated
   * consumed set. In-list → `consumed: true`. Not-in-list → `not-consumed`
   * on `run-end` (terminal); left pending on `run-suspend`. On `run-end`
   * the run-id is recorded as dead and the consumed accumulator for this
   * run is cleared.
   * @param runId - The Run whose lifecycle event just landed.
   * @param isEnd - True for `run-end`; false for `run-suspend`.
   * @param terminalReason - The run-end's reason; present iff `isEnd`.
   */
  private _resolveOutcomes(runId: string, isEnd: boolean, terminalReason: RunEndReason | undefined): void {
    const consumedSet = this._consumedByRunId.get(runId);
    const bucket = this._inflightSteers.get(runId);
    if (bucket !== undefined && bucket.length > 0) {
      const remaining: InflightSteer[] = [];
      for (const entry of bucket) {
        const consumed = consumedSet?.has(entry.steerCodecMessageId) ?? false;
        if (consumed) {
          entry.resolve(
            terminalReason === undefined ? { consumed: true } : { consumed: true, runTerminalReason: terminalReason },
          );
        } else if (isEnd) {
          entry.resolve(
            terminalReason === undefined ? { consumed: false } : { consumed: false, runTerminalReason: terminalReason },
          );
        } else {
          // Suspend leaves the outcome pending — a later resume may consume
          // the steer; only run-end can definitively report not-consumed.
          remaining.push(entry);
        }
      }
      if (remaining.length === 0) this._inflightSteers.delete(runId);
      else this._inflightSteers.set(runId, remaining);
    }
    if (isEnd) {
      this._deadRunIds.add(runId);
      this._consumedByRunId.delete(runId);
      // Drain any pending-echo entries targeting this Run too: their
      // channel echo never landed before the terminal lifecycle event, so
      // the codec-message-id couldn't be matched against the accumulated
      // consumed set. Resolve `published` with a missing serial (the echo
      // will not be observed) and resolve `outcome` as not-consumed with
      // the terminal reason. Without this drain a run-end racing ahead of
      // a steer's own publish echo would orphan its outcome promise.
      for (const [codecMessageId, pending] of this._pendingEchoes) {
        if (pending.runId !== runId) continue;
        this._pendingEchoes.delete(codecMessageId);
        pending.resolvePublished({ serial: undefined });
        pending.resolveOutcome(
          terminalReason === undefined ? { consumed: false } : { consumed: false, runTerminalReason: terminalReason },
        );
      }
    }
  }
}
