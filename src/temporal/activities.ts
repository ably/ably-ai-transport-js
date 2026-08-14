/**
 * The framing activities the plugin registers.
 *
 * Framing is everything that brackets a turn — opening the run, and publishing
 * its terminal — as opposed to the inference itself, which stays the
 * application's. Each one carries no application types, which is what makes it
 * safe for the SDK to own.
 *
 * Each activity takes a connected session from the shared {@link SessionScope},
 * does one thing, and hands the lease back. The scope spans the worker process
 * and owns the connection pool, so nothing here builds or closes a client. What
 * an activity may not assume is that it shares state with the activity before it:
 * a retry can land on another worker, so identity travels in the activity's input
 * and the run is re-adopted from the channel every time.
 */

import { Context } from '@temporalio/activity';
import * as Ably from 'ably';

import type { CodecOutputEvent } from '../core/codec/types.js';
import { pageUntilLocated } from '../core/transport/page-until-located.js';
import type { RunIdentity } from '../core/transport/types/agent.js';
import { ErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import type { SessionScope } from './session-scope.js';
import type {
  CleanupRunInput,
  EndRunInput,
  FramingActivities,
  OpenRunInput,
  SuspendRunInput,
} from './workflow/activity-types.js';

/** What {@link createFramingActivities} needs from the plugin that builds it. */
export interface FramingActivitiesDeps<TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /** The shared session scope, which owns the codec and the client pool. */
  scope: SessionScope<TOutput, TProjection, TMessage>;
  /** Logger for the paging progress hook. */
  logger?: Logger;
  /**
   * Whether the scope heartbeats. `openRun` uses it to decide whether to report
   * progress per history page as well as on the scope's timer.
   */
  heartbeat?: boolean;
  /** Most history pages `openRun` fetches before giving up. */
  maxHistoryPages?: number;
  /** CodecMessages revealed per history page. */
  historyPageSize?: number;
}

/**
 * Build the framing activities against a session scope.
 *
 * A factory rather than module-level state, so a worker can host more than one
 * configuration and nothing is global.
 * @template TOutput - The codec output event type.
 * @template TProjection - The codec projection type.
 * @template TMessage - The codec message type.
 * @param options - The session scope and paging behaviour.
 * @returns The four activities, ready to register on a worker.
 */
export const createFramingActivities = <TOutput extends CodecOutputEvent, TProjection, TMessage>(
  options: FramingActivitiesDeps<TOutput, TProjection, TMessage>,
): FramingActivities => {
  const { logger, scope } = options;
  const heartbeat = options.heartbeat ?? false;

  return {
    openRun: async (input: OpenRunInput): Promise<RunIdentity> => {
      const cancelSignal = Context.current().cancellationSignal;
      return scope.inSession(input.invocation, async ({ session, invocation }) => {
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
      await scope.inSession(input.invocation, async ({ session, invocation }) => {
        const run = session.adoptRun(invocation, input.ids, { signal: cancelSignal });
        await run.load();
        if (input.reason === 'error') {
          await run.end({
            reason: 'error',
            error: new Ably.ErrorInfo(input.errorMessage ?? 'run failed', ErrorCode.StreamError, 500),
          });
          return;
        }
        await run.end({ reason: input.reason });
      });
    },

    suspendRun: async (input: SuspendRunInput): Promise<void> => {
      const cancelSignal = Context.current().cancellationSignal;
      await scope.inSession(input.invocation, async ({ session, invocation }) => {
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
      await scope.inSession(input.invocation, async ({ session, invocation }) => {
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
            error: new Ably.ErrorInfo(input.errorMessage ?? 'workflow failed', ErrorCode.StreamError, 500),
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
