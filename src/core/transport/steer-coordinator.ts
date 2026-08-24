/**
 * Client-side steer state machine.
 *
 * Owns every piece of state involved in the `ClientTransport.steer(...)` →
 * lifecycle-event lifecycle:
 *   - {@link _inflightSteers} — outcome handlers awaiting a lifecycle
 *     event on the targeted run. `published` needs no such state: it
 *     resolves from the publish acknowledgement's serial, so it works even
 *     for a client that receives no echo of its own publishes
 *     (`echoMessages: false`).
 *   - {@link _consumedByRunId} — accumulator of `steer-codec-message-ids`
 *     stamps observed on the run's response messages.
 *   - {@link _deadRunIds} — runs whose `run-end` the SDK has folded (with
 *     the terminal reason); subsequent `steer()` calls reject synchronously,
 *     and a publish that raced the terminal resolves not-consumed.
 *
 * The hosting client transport wires it up by:
 *   1. constructing it with a publish callback, a clientId resolver, and
 *      a closed predicate;
 *   2. calling `observeMessage(msg)` from its channel listener for every
 *      inbound message;
 *   3. exposing `steer(runIdPromise, input)` as `ClientTransport.steer`;
 *   4. calling `drainContinuityLost(err)` on a channel discontinuity;
 *   5. calling `drainClosed()` on transport close.
 */

import * as Ably from 'ably';

import {
  EVENT_RUN_END,
  EVENT_RUN_SUSPEND,
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
   * Publish a steer input on the channel. Wraps the transport's
   * `Encoder<TInput, _>.publishInput` so the coordinator does not need
   * to know about TOutput. Resolves with the publish acknowledgement —
   * the Ably-assigned serials — which is what resolves `published`.
   */
  publish: (input: TInput, opts: WriteOptions) => Promise<Ably.PublishResult>;
  /**
   * Resolve the publisher's `clientId` at publish time. Stamped on each
   * steer's `run-client-id` header.
   */
  clientId: () => string | undefined;
  /**
   * Whether the hosting transport is closed. Checked once after the
   * `runIdPromise` resolves so a close-during-await rejects cleanly
   * instead of publishing into a dead transport.
   */
  isTransportClosed: () => boolean;
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
  /** Reject the outcome promise (continuity loss, transport close). */
  reject: (e: Ably.ErrorInfo) => void;
}

/**
 * Owns the client-side steer lifecycle for one client transport. See the
 * module doc for the state it holds and how the transport wires it in.
 * @template TInput - The codec's input event type.
 */
export class SteerCoordinator<TInput> {
  private readonly _publish: (input: TInput, opts: WriteOptions) => Promise<Ably.PublishResult>;
  private readonly _clientId: () => string | undefined;
  private readonly _isTransportClosed: () => boolean;
  private readonly _logger: Logger;

  /** In-flight steer outcomes awaiting resolution, keyed by run-id. */
  private readonly _inflightSteers = new Map<string, InflightSteer[]>();

  /**
   * Per-run union of codec-message-ids the agent has stamped as consumed on
   * its response messages (`steer-codec-message-ids` header). Cleared on
   * `run-end` after resolving the matching in-flight bucket, and on close.
   */
  private readonly _consumedByRunId = new Map<string, Set<string>>();

  /**
   * Runs the SDK has observed a `run-end` for, with the terminal reason.
   * Subsequent `steer()` calls targeting these reject without publishing,
   * and a steer whose publish was in flight when the terminal landed
   * resolves not-consumed with this reason.
   */
  private readonly _deadRunIds = new Map<string, RunEndReason | undefined>();

  /**
   * Bumped by each drain, with the drain's error retained. A steer whose
   * publish was in flight when a drain ran must not register an in-flight
   * entry afterwards (nothing would ever settle it), so the publish path
   * rejects its outcome with the drain's error instead.
   */
  private _drainEpoch = 0;
  private _lastDrainError: Ably.ErrorInfo | undefined;

  constructor(options: SteerCoordinatorOptions<TInput>) {
    this._publish = options.publish;
    this._clientId = options.clientId;
    this._isTransportClosed = options.isTransportClosed;
    this._logger = options.logger.withContext({ component: 'SteerCoordinator' });
  }

  /**
   * Publish a steering user-message targeting `runId`. Awaits the caller's
   * `runIdPromise` so a steer attempted before `ai-run-start` lands is
   * delayed (not rejected) until the agent has minted the id. `published`
   * resolves with the publish acknowledgement's serial — no channel echo is
   * involved, so it works for a client with `echoMessages: false` — and the
   * outcome handler registers in `_inflightSteers` under the resolved
   * `runId` once the publish is acknowledged.
   *
   * Dead-handle: if the SDK has already folded a `run-end` for the run
   * (recorded in {@link _deadRunIds}), or if `runIdPromise` rejects, both
   * returned promises reject without any channel publish. A run-end that
   * lands while the publish is in flight resolves the outcome not-consumed
   * with the terminal reason.
   * @param runIdPromise - The handle's `runId` promise (may be unresolved).
   * @param input - The codec input event to publish, in the codec's input shape.
   * @returns The {@link SteerResult} pair.
   */
  steer(runIdPromise: Promise<string>, input: TInput): SteerResult {
    // Build the published/outcome promise pair up front so we can return
    // them synchronously. The publish lifecycle runs in an async IIFE
    // below; `published`'s serial resolves from the publish
    // acknowledgement.
    const {
      promise: published,
      resolve: resolvePublished,
      reject: rejectPublished,
    } = Promise.withResolvers<{ serial: string | undefined }>();
    const { promise: outcome, resolve: resolveOutcome, reject: rejectOutcome } = Promise.withResolvers<SteerOutcome>();
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

      if (this._isTransportClosed()) {
        const err = new Ably.ErrorInfo('unable to steer; transport is closed', ErrorCode.SessionClosed, 400);
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

      // The steer publishes on `ai-input` with the `run-id` header set — the
      // marker the agent transport routes onto the run's steer tracking, and
      // a consumer folds like any other input.
      const epoch = this._drainEpoch;
      let ack: Ably.PublishResult;
      try {
        ack = await this._publish(input, { extras: { headers }, messageId: codecMessageId });
      } catch (error) {
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
        return;
      }
      resolvePublished({ serial: ack.serials[0] ?? undefined });

      // A drain (continuity loss, close) ran while the publish was in
      // flight: the state it would register into was cleared, so settle the
      // outcome with the drain's error rather than leaving it to hang.
      if (this._drainEpoch !== epoch) {
        rejectOutcome(
          this._lastDrainError ??
            new Ably.ErrorInfo('unable to await steer outcome; transport is closed', ErrorCode.SessionClosed, 400),
        );
        return;
      }

      // The run's terminal can land while the publish is in flight; the
      // in-flight registration below would never resolve, so settle the
      // outcome from the recorded terminal instead.
      if (this._deadRunIds.has(resolvedRunId)) {
        const terminalReason = this._deadRunIds.get(resolvedRunId);
        resolveOutcome(
          terminalReason === undefined ? { consumed: false } : { consumed: false, runTerminalReason: terminalReason },
        );
        return;
      }

      // Register the outcome handler on the run's bucket. The next
      // `run-suspend`/`run-end` for this run resolves it by checking whether
      // `steerCodecMessageId` is in the accumulated consumed set.
      const entry: InflightSteer = {
        steerCodecMessageId: codecMessageId,
        resolve: resolveOutcome,
        reject: rejectOutcome,
      };
      const bucket = this._inflightSteers.get(resolvedRunId);
      if (bucket === undefined) this._inflightSteers.set(resolvedRunId, [entry]);
      else bucket.push(entry);
    })();

    return { published, outcome };
  }

  /**
   * Process an inbound channel message. The coordinator inspects two
   * orthogonal facets:
   *   1. Stamp accumulation — if the message carries
   *      `steer-codec-message-ids`, union the listed ids into the run's
   *      consumed set.
   *   2. Lifecycle resolution — on `ai-run-suspend` / `ai-run-end`,
   *      resolve in-flight outcomes for the run by membership.
   * @param msg - The inbound Ably message just delivered to the channel.
   */
  observeMessage(msg: Ably.InboundMessage): void {
    const headers = getTransportHeaders(msg);

    // (1) Stamp accumulation: union the `steer-codec-message-ids` delta
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

    // (2) Lifecycle resolution.
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
   * Drain every in-flight bucket on channel continuity loss. Post-loss the
   * channel will not deliver the run lifecycle events that would have
   * resolved these promises, so they would otherwise hang until close().
   * @param err - The continuity-loss error to reject outcomes with.
   */
  drainContinuityLost(err: Ably.ErrorInfo): void {
    this._drainEpoch += 1;
    this._lastDrainError = err;
    for (const bucket of this._inflightSteers.values()) {
      for (const entry of bucket) entry.reject(err);
    }
    this._inflightSteers.clear();
    this._deadRunIds.clear();
    this._consumedByRunId.clear();
  }

  /**
   * Drain on transport close. Rejects any in-flight outcomes so callers
   * awaiting them settle rather than hang. Steers whose `published` already
   * resolved still see their `outcome` promise reject here.
   */
  drainClosed(): void {
    const closedErr = new Ably.ErrorInfo(
      'unable to await steer outcome; transport is closed',
      ErrorCode.SessionClosed,
      400,
    );
    this._drainEpoch += 1;
    this._lastDrainError = closedErr;
    for (const bucket of this._inflightSteers.values()) {
      for (const entry of bucket) entry.reject(closedErr);
    }
    this._inflightSteers.clear();
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
      // Record the terminal (with its reason) so a steer whose publish is
      // still in flight resolves not-consumed instead of registering an
      // in-flight entry nothing will ever settle.
      this._deadRunIds.set(runId, terminalReason);
      this._consumedByRunId.delete(runId);
    }
  }
}
