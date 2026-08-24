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

/** The latest lifecycle state of a run, merged from channel history. */
type RunState = 'start' | 'suspend' | 'resume' | 'end';

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
   * @param invocationData - The invocation whose `channelName` is the channel.
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
        const channel = client.channels.get(invocation.channelName);
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
   * Merge the run's latest lifecycle state from channel history, paging
   * backwards until the run is seen, the channel is exhausted, or the page
   * bound is hit. `undefined` means the run was not found in the pages read —
   * a paging artefact, not a fact about the run; each activity decides what
   * that means for its own retry semantics.
   * @param transport - The connected transport whose history to page.
   * @param runId - The run to classify.
   * @returns The run's latest lifecycle state, or `undefined` when not found.
   */
  const latestRunState = async (
    transport: AgentTransport<TInput, TOutput>,
    runId: string,
  ): Promise<RunState | undefined> => {
    for (let page = 0; options.maxHistoryPages === undefined || page < options.maxHistoryPages; page++) {
      const batch = await transport.history({ ...(onPage && { onPage }) });
      // Each batch is older than the last, and chronological within — so the
      // first batch mentioning the run holds its latest state at that batch's
      // newest matching event.
      for (let i = batch.events.length - 1; i >= 0; i--) {
        const event = batch.events[i];
        if (event?.kind === 'run-lifecycle' && event.event.runId === runId) {
          return event.event.type;
        }
      }
      if (batch.exhausted) return undefined;
    }
    return undefined;
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
      const unsubscribe = transport.subscribe((event) => {
        if (event.kind !== 'run-lifecycle' || event.event.runId !== runId) return;
        if (event.event.type === 'start' || event.event.type === 'resume') {
          unsubscribe();
          resolve();
        }
      });
      signal.addEventListener('abort', () => {
        unsubscribe();
        reject(new Ably.ErrorInfo('unable to open run; activity cancelled', ErrorCode.OperationCancelled, 400));
      });
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
          ...(options.maxHistoryPages !== undefined &&
            options.historyPageSize !== undefined && {
              limit: options.maxHistoryPages * options.historyPageSize,
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
        const { promise: openFailed, reject: failOpen } = Promise.withResolvers<never>();
        // .catch(): the race below observes the rejection; without a pre-attached
        // handler the losing branch would surface as an unhandled rejection.
        openFailed.catch(() => {
          /* observed via the race */
        });
        const run = transport.openRun(
          {
            input: located,
            runId: input.invocationId,
            invocationId: input.invocationId,
          },
          {
            signal: cancelSignal,
            onError: (error) => {
              failOpen(error);
            },
          },
        );
        // The opening publish is fire-and-forget inside openRun, so a publish
        // failure surfaces only through the run's onError hook — race it
        // against the echo, or a failed open would hang this activity until
        // its Temporal timeout instead of failing fast for retry. Subscribing
        // after openRun is safe: no await separates them, so the echo cannot
        // be delivered in between.
        const opened = awaitRunOpen(transport, run.runId, cancelSignal);
        await Promise.race([opened, openFailed]);

        return { runId: run.runId, invocationId: input.invocationId };
      });
    },

    endRun: async (input: EndRunInput): Promise<void> => {
      const cancelSignal = Context.current().cancellationSignal;
      await inTransport(input.invocation, async ({ transport }) => {
        const state = await gateOpenRun(transport, input.ids.runId, latestRunState);
        if (state !== 'ok') return rejectGate(state, input.ids.runId);
        const run = transport.adoptRun(input.ids.runId, { signal: cancelSignal });
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
        const state = await gateOpenRun(transport, input.ids.runId, latestRunState);
        if (state !== 'ok') return rejectGate(state, input.ids.runId);
        const run = transport.adoptRun(input.ids.runId, { signal: cancelSignal });
        await run.suspend();
      });
    },

    cleanupRun: async (input: CleanupRunInput): Promise<void> => {
      // No cancellation signal: this is the cleanup arm, so it must still run
      // while the workflow itself is being cancelled.
      await inTransport(input.invocation, async ({ transport }) => {
        const state = await gateOpenRun(transport, input.ids.runId, latestRunState);
        // A suspended run is a client's to resume; an ended run needs nothing;
        // a run not found in the pages read has nothing this best-effort arm
        // can safely do. Only a still-open run is ended.
        if (state !== 'ok') return;
        const run = transport.adoptRun(input.ids.runId);
        await run.end({
          reason: 'error',
          error: new Ably.ErrorInfo(input.errorMessage ?? 'workflow failed', ErrorCode.RunResponseStreamFailed, 500),
        });
      });
    },
  };
};

/** The gate's verdict: `ok` to proceed, or why not. */
type GateResult = 'ok' | 'suspended' | 'ended' | 'not-found';

/**
 * Classify whether the run is still open — the shared gate the terminal
 * activities run before adopting the run via `adoptRun`.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 * @param transport - The connected transport whose history to page.
 * @param runId - The run to gate on.
 * @param latestRunState - The history merge to classify with.
 * @returns The gate's verdict.
 */
const gateOpenRun = async <TInput, TOutput>(
  transport: AgentTransport<TInput, TOutput>,
  runId: string,
  latestRunState: (transport: AgentTransport<TInput, TOutput>, runId: string) => Promise<RunState | undefined>,
): Promise<GateResult> => {
  const state = await latestRunState(transport, runId);
  if (state === undefined) return 'not-found';
  if (state === 'suspend') return 'suspended';
  if (state === 'end') return 'ended';
  return 'ok';
};

/**
 * Throw the gate's failure. The codes drive the workflow-side retry
 * semantics: a suspended or ended run is a non-retryable misuse
 * (`InvalidArgument`), a run not found in the pages read is retryable
 * (`InputEventNotFound` — a paging artefact, not a fact about the run).
 * @param state - The gate's non-`ok` verdict.
 * @param runId - The gated run, for the message.
 */
const rejectGate = (state: Exclude<GateResult, 'ok'>, runId: string): never => {
  if (state === 'not-found') {
    throw new Ably.ErrorInfo(
      `unable to re-enter run ${runId}; its opening event was not found in channel history`,
      ErrorCode.NotFound,
      404,
    );
  }
  throw new Ably.ErrorInfo(
    state === 'suspended'
      ? `unable to re-enter run ${runId}; the run is suspended — resume it via a fresh openRun`
      : `unable to re-enter run ${runId}; the run has already ended`,
    ErrorCode.InvalidArgument,
    400,
  );
};
