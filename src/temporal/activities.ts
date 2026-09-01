/**
 * The framing activities the plugin registers.
 *
 * Framing is everything that brackets a turn — opening the run, and publishing
 * its terminal — as opposed to the inference itself, which stays the
 * application's. Each one carries no application types, which is what makes it
 * safe for the SDK to own.
 *
 * Every activity runs in a fresh process, so each builds its own Ably client
 * and agent transport, does one thing, and tears both down. The client comes
 * from a caller-supplied factory: the SDK never reads the environment or
 * constructs clients. The channel is caller-owned by the transport contract,
 * so closing the transport publishes no terminal — a run an activity leaves
 * open stays open on the wire for a later activity to re-enter.
 */

import { Context } from '@temporalio/activity';
import * as Ably from 'ably';

import type { WireCodec } from '../core/codec/types.js';
import { createAgentTransport } from '../core/transport/agent-transport.js';
import { Invocation } from '../core/transport/invocation.js';
import type { AgentTransport, RunIdentity } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import { withHeartbeat } from './heartbeat.js';
import type {
  CleanupRunInput,
  EndRunInput,
  FramingActivities,
  OpenRunInput,
  SuspendRunInput,
} from './workflow/activity-types.js';

/**
 * Page size assumed when a caller bounds the locate scan with
 * `maxHistoryPages` but names no `historyPageSize`. Mirrors the transport's own
 * default, so the bound means what its name says without the caller having to
 * set both.
 */
const DEFAULT_LOCATE_PAGE_SIZE = 100;

/** Configuration for {@link createFramingActivities}. */
export interface FramingActivitiesOptions<TInput, TOutput> {
  /** The codec the transports encode with. */
  codec: WireCodec<TInput, TOutput>;
  /**
   * Builds the Ably client for one activity. Called once per activity
   * invocation; the returned client is closed before the activity returns.
   */
  createClient: () => Ably.Realtime;
  /** Logger propagated into every transport. */
  logger?: Logger;
  /** Report progress to Temporal while paging history. Defaults to false. */
  heartbeat?: boolean;
  /** Most history pages a scan fetches before giving up. Omit to page to channel exhaustion. */
  maxHistoryPages?: number;
  /** Wire-message limit per history page. */
  historyPageSize?: number;
}

/**
 * Build the framing activities, bound to a codec and a client factory.
 *
 * A factory rather than module-level state, so a worker can host more than one
 * configuration and nothing is global.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 * @param options - Codec, client factory, and paging behaviour.
 * @returns The four activities, ready to register on a worker.
 */
export const createFramingActivities = <TInput, TOutput>(
  options: FramingActivitiesOptions<TInput, TOutput>,
): FramingActivities => {
  const { codec, createClient, logger } = options;
  const heartbeat = options.heartbeat ?? false;

  /** Per-page heartbeat for the history scans, when enabled. */
  const onPage = heartbeat
    ? (): void => {
        Context.current().heartbeat();
      }
    : undefined;

  /**
   * Run `body` against a connected agent transport on its own client, closing
   * the transport and the client afterwards. Closing publishes no terminal —
   * "do not publish a terminal" is the whole hand-off discipline a durable
   * activity needs.
   * @template T - The body's return type.
   * @param invocationData - The invocation whose `sessionName` is the channel.
   * @param body - The work to run against the transport.
   * @returns Whatever `body` returns.
   */
  const inTransport = async <T>(
    invocationData: OpenRunInput['invocation'],
    body: (ctx: { transport: AgentTransport<TInput, TOutput>; invocation: Invocation }) => Promise<T>,
  ): Promise<T> => {
    const invocation = Invocation.fromJSON(invocationData);
    const client = createClient();
    try {
      return await withHeartbeat(heartbeat, async () => {
        const channel = client.channels.get(invocation.sessionName);
        const transport = createAgentTransport<TInput, TOutput>({
          channel,
          codec,
          ...(logger && { logger }),
          ...(options.historyPageSize !== undefined && { historyPageSize: options.historyPageSize }),
        });
        await transport.connect();
        try {
          return await body({ transport, invocation });
        } finally {
          transport.close();
        }
      });
    } finally {
      client.close();
    }
  };

  /**
   * Resolve once the run's opening event (`ai-run-start` / `ai-run-resume`)
   * echoes back on the receive stream — the confirmation that the open reached
   * the wire, so the activity can report success and hand off. Rejects when
   * the activity is cancelled first.
   * @param transport - The connected transport to observe.
   * @param runId - The run whose opening echo to await.
   * @param signal - The activity's cancellation signal.
   * @returns Resolves on the opening echo.
   */
  const awaitRunOpen = async (
    transport: AgentTransport<TInput, TOutput>,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      // An already-aborted signal never fires `abort`, so check it before
      // subscribing: otherwise this promise never settles and the activity
      // stalls to its startToClose timeout instead of failing fast.
      if (signal.aborted) {
        reject(activityCancelled());
        return;
      }
      const onAbort = (): void => {
        unsubscribe();
        reject(activityCancelled());
      };
      const unsubscribe = transport.subscribe((event) => {
        if (event.kind !== 'run-lifecycle' || event.event.runId !== runId) return;
        if (event.event.type === 'start' || event.event.type === 'resume') {
          signal.removeEventListener('abort', onAbort);
          unsubscribe();
          resolve();
        }
      });
      signal.addEventListener('abort', onAbort);
    });

  return {
    openRun: async (input: OpenRunInput): Promise<RunIdentity> => {
      const cancelSignal = Context.current().cancellationSignal;
      return inTransport(input.invocation, async ({ transport, invocation }) => {
        // The trigger was published before this process attached, so it sits
        // in channel history. Locate it and no more: this activity runs no
        // inference, so it never needs the rest of the conversation. A retry
        // that cannot find it throws before publishing and leaves no orphaned
        // run.
        const located = await transport.locateInput(invocation.inputEventId, {
          signal: cancelSignal,
          ...(onPage && { onPage }),
          // Bounded on `maxHistoryPages` alone: `historyPageSize` has a
          // transport-side default, so requiring both would silently ignore a
          // caller who set only the bound. `limit` counts events while
          // `historyPageSize` bounds wire messages, so the product is an
          // exact page bound: `limit` caps the wire messages scanned, page
          // granular, so the product bounds the pages the scan fetches.
          ...(options.maxHistoryPages !== undefined && {
            limit: options.maxHistoryPages * (options.historyPageSize ?? DEFAULT_LOCATE_PAGE_SIZE),
          }),
        });
        if (!located) {
          throw new Ably.ErrorInfo(
            `unable to open run; input event ${invocation.inputEventId} not found in channel history`,
            ErrorCode.NotFound,
            404,
          );
        }

        // The located input drives the open: its run-id header names the run
        // a continuation re-enters (publishing `ai-run-resume`); without one,
        // a fresh turn opens under the pinned `runId` — the invocation id,
        // which a durable framework holds constant across retries, so a
        // fresh-process retry re-enters the SAME run instead of minting a new
        // id and opening a parallel one.
        const run = transport.openRun(
          {
            input: located,
            runId: input.invocationId,
            invocationId: input.invocationId,
          },
          { signal: cancelSignal },
        );
        // The opening publish is fire-and-forget inside openRun, so its
        // failure surfaces only through the handle's `opened`. Race the echo
        // against that rejection: a failed open fails this activity fast for
        // retry instead of stalling until the activity timeout, while a
        // successful open still waits for the echo, so the hand-off happens
        // strictly after the open is on the wire. Subscribing after openRun
        // is safe: no await separates them, so the echo cannot be delivered
        // in between.
        const { promise: openFailed, reject: failOpen } = Promise.withResolvers<never>();
        // .catch(): rejection-only view — `opened` resolving must not settle
        // the race, only the echo may.
        run.opened.catch(failOpen);
        await Promise.race([awaitRunOpen(transport, run.runId, cancelSignal), openFailed]);

        return { runId: run.runId, invocationId: input.invocationId };
      });
    },

    endRun: async (input: EndRunInput): Promise<void> => {
      const cancelSignal = Context.current().cancellationSignal;
      await inTransport(input.invocation, async ({ transport }) => {
        // No wire-state check: this activity adopts and publishes. A retry
        // after a crash that already published puts a second `ai-run-end` on
        // the channel, which readers absorb by respecting the first terminal
        // in serial order.
        const run = transport.adoptRun(
          input.ids.runId,
          { invocationId: input.ids.invocationId },
          { signal: cancelSignal },
        );
        if (input.reason === 'error') {
          await run.end({
            reason: 'error',
            error: new Ably.ErrorInfo(input.errorMessage ?? 'run failed', ErrorCode.RunResponseStreamFailed, 500),
          });
          return;
        }
        await run.end({ reason: input.reason });
      });
    },

    suspendRun: async (input: SuspendRunInput): Promise<void> => {
      const cancelSignal = Context.current().cancellationSignal;
      await inTransport(input.invocation, async ({ transport }) => {
        // No wire-state check, as in `endRun`: adopt and publish.
        const run = transport.adoptRun(
          input.ids.runId,
          { invocationId: input.ids.invocationId },
          { signal: cancelSignal },
        );
        await run.suspend();
      });
    },

    cleanupRun: async (input: CleanupRunInput): Promise<void> => {
      // No cancellation signal: this is the cleanup arm, so it must still run
      // while the workflow itself is being cancelled.
      await inTransport(input.invocation, async ({ transport }) => {
        // No wire-state check: the cleanup arm publishes its error terminal
        // unconditionally. When the run already ended, this adds a second
        // `ai-run-end` that readers ignore in favour of the first, so the
        // cost is channel noise rather than a wrong state.
        const run = transport.adoptRun(input.ids.runId, { invocationId: input.ids.invocationId });
        await run.end({
          reason: 'error',
          error: new Ably.ErrorInfo(input.errorMessage ?? 'workflow failed', ErrorCode.RunResponseStreamFailed, 500),
        });
      });
    },
  };
};

/**
 * The error an open-echo wait rejects with when the activity is cancelled,
 * whether the signal aborts mid-wait or was already aborted on entry.
 * @returns The cancellation error.
 */
const activityCancelled = (): Ably.ErrorInfo =>
  new Ably.ErrorInfo('unable to open run; activity cancelled', ErrorCode.OperationCancelled, 400);
