/**
 * The framing activities the plugin registers.
 *
 * Framing is everything that brackets a turn — opening the run, and publishing
 * its terminal — as opposed to the inference itself, which stays the
 * application's. Each one carries no application types, which is what makes it
 * safe for the SDK to own.
 *
 * Every activity runs in a fresh process, so each builds its own Ably client and
 * session, does one thing, and tears both down. The client comes from a
 * caller-supplied factory: the SDK never reads the environment or constructs
 * clients. A client per activity is required, not merely tidy — a session takes
 * its channel from `client.channels.get(name)`, which caches per name, and
 * detaching a session detaches that channel, so two sessions sharing a client on
 * one channel would break each other.
 */

import { Context } from '@temporalio/activity';
import * as Ably from 'ably';

import { pageUntilLocated } from '../core/transport/page-until-located.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../core/transport/session-codec.js';
import type { RunIdentity } from '../core/transport/types/transport.js';
import { withAgentSession } from '../core/transport/with-agent-session.js';
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
export interface FramingActivitiesOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The codec the sessions encode with. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /**
   * Builds the Ably client for one activity. Called once per activity
   * invocation; the returned client is closed before the activity returns.
   */
  createClient: () => Ably.Realtime;
  /** Logger propagated into every session. */
  logger?: Logger;
  /** Report progress to Temporal while paging history. Defaults to false. */
  heartbeat?: boolean;
  /** Most history pages `openRun` fetches before giving up. */
  maxHistoryPages?: number;
  /** CodecMessages revealed per history page. */
  historyPageSize?: number;
}

/**
 * Build the framing activities, bound to a codec and a client factory.
 *
 * A factory rather than module-level state, so a worker can host more than one
 * configuration and nothing is global.
 * @template TInput - The codec input event type.
 * @template TOutput - The codec output event type.
 * @template TProjection - The codec projection type.
 * @template TMessage - The codec message type.
 * @param options - Codec, client factory, and paging behaviour.
 * @returns The four activities, ready to register on a worker.
 */
export const createFramingActivities = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: FramingActivitiesOptions<TInput, TOutput, TProjection, TMessage>,
): FramingActivities => {
  const { codec, createClient, logger } = options;
  const heartbeat = options.heartbeat ?? false;

  /**
   * Run `body` against a connected session on its own client, closing the
   * client afterwards. `withAgentSession` owns the session half, including
   * detaching rather than ending it.
   * @template T - The body's return type.
   * @param invocation - The invocation the session serves.
   * @param body - The work to run against the session.
   * @returns Whatever `body` returns.
   */
  const inSession = async <T>(
    invocation: OpenRunInput['invocation'],
    body: Parameters<typeof withAgentSession<TInput, TOutput, TProjection, TMessage, T>>[1],
  ): Promise<T> => {
    const client = createClient();
    try {
      return await withHeartbeat(heartbeat, async () =>
        withAgentSession<TInput, TOutput, TProjection, TMessage, T>({ client, invocation, codec, logger }, body),
      );
    } finally {
      client.close();
    }
  };

  return {
    openRun: async (input: OpenRunInput): Promise<RunIdentity> => {
      const cancelSignal = Context.current().cancellationSignal;
      return inSession(input.invocation, async ({ session, invocation }) => {
        const run = session.createRun(
          invocation,
          {
            invocationId: input.invocationId,
            // Pin the run id to the invocation id, which a durable framework
            // holds constant across retries. A fresh-process retry then
            // re-enters the SAME run rather than minting a new id and opening a
            // parallel one; the retry's `ai-run-start` folds idempotently onto
            // the existing node. A continuation ignores this — its run id comes
            // from the trigger's wire headers — so it only pins a fresh run.
            runId: input.invocationId,
          },
          { signal: cancelSignal },
        );

        // The trigger was published before this process attached, so it sits in
        // channel history. Page until it surfaces and no further: this activity
        // runs no inference, so it never needs the rest of the conversation.
        await pageUntilLocated(run, {
          inputEventId: invocation.inputEventId,
          ...(options.maxHistoryPages !== undefined && { maxPages: options.maxHistoryPages }),
          ...(options.historyPageSize !== undefined && { pageSize: options.historyPageSize }),
          ...(heartbeat && {
            onPage: () => {
              Context.current().heartbeat();
            },
          }),
          ...(logger && { logger }),
        });

        // Publishes `ai-run-start` for a fresh run, `ai-run-resume` for a
        // continuation, told apart by the trigger's run-id header. Blocks until
        // the trigger is located, so a retry that cannot find it throws before
        // publishing and leaves no orphaned run.
        await run.start();

        return { runId: run.runId, invocationId: run.invocationId };
      });
    },

    endRun: async (input: EndRunInput): Promise<void> => {
      const cancelSignal = Context.current().cancellationSignal;
      await inSession(input.invocation, async ({ session, invocation }) => {
        const run = session.adoptRun(invocation, input.ids, { signal: cancelSignal });
        await run.load();
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
      await inSession(input.invocation, async ({ session, invocation }) => {
        const run = session.adoptRun(invocation, input.ids, { signal: cancelSignal });
        await run.load();
        // Throws if a step is still open — suspending mid-step would strand the
        // step bracket, so closing it is the caller's job.
        await run.suspend();
      });
    },

    cleanupRun: async (input: CleanupRunInput): Promise<void> => {
      // No cancellation signal: this is the cleanup arm, so it must still run
      // while the workflow itself is being cancelled.
      await inSession(input.invocation, async ({ session, invocation }) => {
        const run = session.adoptRun(invocation, input.ids);

        try {
          try {
            // load() status-gates: it rejects a run that is already suspended
            // (a client will resume it) or terminal (already ended). Either way
            // there is nothing to clean up.
            await run.load();
          } catch {
            return;
          }

          await run.end({
            reason: 'error',
            error: new Ably.ErrorInfo(input.errorMessage ?? 'workflow failed', ErrorCode.RunResponseStreamFailed, 500),
          });
        } catch (error) {
          // End rather than detach here: this is the terminal path, so ending
          // any run still open is the intent, and session.end() cascades to do
          // it. The scaffold's detach afterwards is a no-op on an ended session.
          try {
            await session.end();
          } catch {
            /* best-effort — the channel may already be gone */
          }
          throw error;
        }
      });
    },
  };
};
