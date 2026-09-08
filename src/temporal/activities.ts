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

import { channelAgent } from '../core/agent.js';
import type { WireCodec } from '../core/codec/types.js';
import { createAgentTransport } from '../core/transport/agent-transport.js';
import { DEFAULT_HISTORY_PAGE_SIZE } from '../core/transport/history-pager.js';
import { Invocation } from '../core/transport/invocation.js';
import type { AgentTransport, RunIdentity } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import { beat, withHeartbeat } from './heartbeat.js';
import type { CleanupRunInput, EndRunInput, FramingActivities, OpenRunInput } from './workflow/activity-types.js';

/**
 * Configuration for the framing activities. A consumer supplies this to
 * {@link createAblyTransportPlugin}, which builds and registers the activities
 * itself.
 */
export interface FramingActivitiesOptions<TInput, TOutput> {
  /** The codec the transports encode with. */
  codec: WireCodec<TInput, TOutput>;
  /**
   * Builds the Ably client for one activity. Called once per activity
   * invocation; the returned client is closed before the activity returns.
   *
   * No echo requirement: every framing activity confirms its own publish from
   * the acknowledgement, so `echoMessages: false` is fine.
   */
  createClient: () => Ably.Realtime;
  /** Logger propagated into every transport. */
  logger?: Logger;
  /**
   * Report progress to Temporal while an activity runs. Defaults to true.
   *
   * Two consequences, and the second is why it defaults on. It reports
   * progress, so a long history scan does not look like a hang. It also carries
   * Temporal's cancellation: a server-originated cancel reaches an activity
   * only while it heartbeats (a worker shutdown is the exception, since the
   * worker delivers that one locally), so with this off, a workflow cancelled through
   * `WorkflowHandle.cancel()`, the CLI or the Web UI does not reach the
   * `cancellationSignal` these activities pass to the transport. A client's own
   * `ai-cancel` message is unaffected, because that arrives over the channel.
   *
   * This is a request, not a guarantee. An activity with no `heartbeatTimeout`
   * in its options must not heartbeat, so the pump stays silent for it whatever
   * this is set to. Set `heartbeatTimeout` in the workflow's `activityOptions`
   * to have it beat.
   */
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
 * @returns The three activities, ready to register on a worker.
 */
export const createFramingActivities = <TInput, TOutput>(
  options: FramingActivitiesOptions<TInput, TOutput>,
): FramingActivities => {
  const { codec, createClient } = options;
  // Each layer adds its own context, so a transport built inside an activity
  // is distinguishable in the log from any other AgentTransport.
  const logger = options.logger?.withContext({ component: 'FramingActivities' });
  const heartbeat = options.heartbeat ?? true;

  /**
   * Per-page heartbeat for the history scans, when enabled. `beat` applies
   * Temporal's own gate, so a page hook on an activity with no heartbeat
   * timeout is a no-op rather than a contract breach.
   */
  const onPage = heartbeat ? beat : undefined;

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
  const withAgentTransport = async <T>(
    invocationData: OpenRunInput['invocation'],
    body: (ctx: { transport: AgentTransport<TInput, TOutput>; invocation: Invocation }) => Promise<T>,
  ): Promise<T> => {
    const invocation = Invocation.fromJSON(invocationData);
    const client = createClient();
    try {
      return await withHeartbeat(heartbeat, async () => {
        // This module resolves the channel itself, so nothing downstream can
        // add the attribution afterwards: without it every framing event these
        // activities publish goes out unattributed. The mode set stays the
        // caller's business — an activity publishes lifecycle events only, and
        // the transport's base modes are the default.
        const channel = client.channels.get(invocation.channelName, {
          params: { agent: channelAgent(codec) },
        });
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

  return {
    openRun: async (input: OpenRunInput): Promise<RunIdentity> => {
      const cancelSignal = Context.current().cancellationSignal;
      logger?.trace('framingActivities.openRun();', { invocationId: input.invocationId });
      return withAgentTransport(input.invocation, async ({ transport, invocation }) => {
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
          // caller who set only the bound. `limit` caps the wire messages
          // scanned and is page granular, so the product bounds the pages the
          // scan fetches.
          ...(options.maxHistoryPages !== undefined && {
            limit: options.maxHistoryPages * (options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE),
          }),
        });
        if (!located) {
          logger?.error('framingActivities.openRun(); trigger not found in history', {
            inputEventId: invocation.inputEventId,
          });
          throw new Ably.ErrorInfo(
            `unable to open run; input event ${invocation.inputEventId} not found in channel history`,
            ErrorCode.NotFound,
            404,
          );
        }
        logger?.debug('framingActivities.openRun(); trigger located', {
          inputEventId: invocation.inputEventId,
          serial: located.meta.serial,
        });

        // A cancelled activity must not put a fresh opening event on the
        // channel, and the opening publish is not itself abortable, so the
        // check belongs before the open rather than after it.
        if (cancelSignal.aborted) throw activityCancelled();

        // The located input drives the open: its run-id header references the run
        // a continuation re-enters (publishing `ai-run-resume`); without one, a
        // fresh turn opens under the pinned `runId` — the invocation id, which
        // Temporal holds constant across an activity's retries, so a
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
        // `opened` settles with the opening publish's acknowledgement. Awaiting
        // it does both jobs this activity needs: it hands off to the next
        // activity strictly after the open is accepted onto the channel, and it
        // fails the activity fast for retry when the publish is refused, rather
        // than stalling to the startToClose timeout. The activity never reads
        // its own echo, so nothing here requires the client to echo publishes.
        await run.opened;
        logger?.debug('framingActivities.openRun(); run open', { runId: run.runId });

        return { runId: run.runId, invocationId: input.invocationId };
      });
    },

    endRun: async (input: EndRunInput): Promise<void> => {
      const cancelSignal = Context.current().cancellationSignal;
      logger?.trace('framingActivities.endRun();', { runId: input.ids.runId, reason: input.reason });
      await withAgentTransport(input.invocation, async ({ transport }) => {
        // No wire-state check: this activity adopts and publishes. A retry
        // after a crash that already published puts a second `ai-run-end` on
        // the channel. The SDK's own Vercel adapter absorbs that idempotently;
        // a consumer merging the stream itself is expected to honour the first
        // terminal in serial order.
        const run = transport.adoptRun(
          input.ids.runId,
          { invocationId: input.ids.invocationId },
          { signal: cancelSignal },
        );
        if (input.reason === 'error') {
          await run.end({
            reason: 'error',
            error: new Ably.ErrorInfo(
              input.errorMessage ?? 'unable to complete the run; the turn failed',
              ErrorCode.RunResponseStreamFailed,
              500,
            ),
          });
          return;
        }
        await run.end({ reason: input.reason });
      });
    },

    cleanupRun: async (input: CleanupRunInput): Promise<void> => {
      // Warn, not trace: this arm only runs because the workflow threw, and it
      // publishes a terminal over whatever state the run was in.
      logger?.warn('framingActivities.cleanupRun(); ending the run after a workflow failure', {
        runId: input.ids.runId,
      });
      // No cancellation signal: this is the cleanup arm, so it must still run
      // while the workflow itself is being cancelled.
      await withAgentTransport(input.invocation, async ({ transport }) => {
        // No wire-state check: the cleanup arm publishes its error terminal
        // unconditionally, because reading the run's state would mean a history
        // scan on the one path that has to stay cheap and cancellation-proof.
        //
        // One consequence follows. On a run that already ended, this adds a
        // second `ai-run-end`; a reader honouring the first terminal sees
        // channel noise rather than a wrong state.
        const run = transport.adoptRun(input.ids.runId, { invocationId: input.ids.invocationId });
        await run.end({
          reason: 'error',
          error: new Ably.ErrorInfo(
            input.errorMessage ?? 'unable to complete the run; the workflow failed',
            ErrorCode.RunResponseStreamFailed,
            500,
          ),
        });
      });
    },
  };
};

/**
 * The error `openRun` throws when the activity was already cancelled before it
 * could put the opening event on the channel.
 * @returns The cancellation error.
 */
const activityCancelled = (): Ably.ErrorInfo =>
  new Ably.ErrorInfo('unable to open run; activity cancelled', ErrorCode.OperationCancelled, 400);
