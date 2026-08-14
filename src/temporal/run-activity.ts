/**
 * The consumer-facing activity scaffold.
 *
 * Every activity in a durable agent opens the same way: lease a client, connect a
 * session, adopt the run the workflow is threading, load it, and on the way out
 * tear all of that down whether the body succeeded or threw. That is a dozen
 * lines around three of real work, repeated per activity. This wraps it, so a
 * consumer writes the body and nothing else.
 *
 * Two things come free with the wrapper and are the reason to prefer it over
 * writing the preamble by hand. The run is adopted with the activity's
 * cancellation signal, and the body runs under the scope's heartbeat pump — and
 * without a heartbeat that signal can never fire, because Temporal delivers a
 * cancellation only in the response to a heartbeat.
 */

import { Context } from '@temporalio/activity';

import type { CodecOutputEvent } from '../core/codec/types.js';
import type { Invocation, InvocationData } from '../core/transport/invocation.js';
import type { AgentRun, AgentSession, RunIdentity, RunStep } from '../core/transport/types/agent.js';
import type { SessionScope } from './session-scope.js';
import { stepIdFor } from './step-id.js';

/**
 * CodecMessages revealed per page when draining history. `View.loadOlder`
 * defaults to 10, which turns a long conversation into many round trips.
 */
const DEFAULT_HISTORY_PAGE_SIZE = 100;

/** Pages a drain fetches before giving up, so it cannot run unbounded. */
const DEFAULT_MAX_HISTORY_PAGES = 100;

/** How far a `history: 'full'` drain is allowed to page. */
export interface HistoryPaging {
  /** Pages to fetch before giving up. */
  maxHistoryPages?: number;
  /** CodecMessages revealed per page. */
  historyPageSize?: number;
}

/**
 * Page the whole conversation into the run's view.
 *
 * Stops on the page cap, and on a page that revealed nothing: `loadOlder` returns
 * an empty array on a closed view while `hasOlder` can still report true, and the
 * `await` only yields to microtasks, so without that guard a closed view would
 * spin without letting the heartbeat timer fire.
 * @param view - The run's view, which the pages are revealed into.
 * @param pageSize - CodecMessages to reveal per page.
 * @param maxPages - Pages to fetch before giving up.
 */
const drainHistory = async (view: DrainableView, pageSize: number, maxPages: number): Promise<void> => {
  for (let page = 0; page < maxPages && view.hasOlder(); page++) {
    const revealed = await view.loadOlder(pageSize);
    if (revealed.length === 0) return;
  }
};

/** The part of a run's view {@link drainHistory} reads. */
interface DrainableView {
  /** Whether older history remains. */
  hasOlder(): boolean;
  /**
   * Reveal the next page.
   * @param limit - CodecMessages to reveal.
   */
  loadOlder(limit?: number): Promise<readonly unknown[]>;
}

/**
 * The fields a wrapped activity's input must carry, so the scaffold can find the
 * run. An activity is free to carry more.
 */
export interface RunActivityInput {
  /** The open run's identity, as threaded through the workflow. */
  ids: RunIdentity;
  /** The invocation the run belongs to; its `sessionName` is the channel. */
  invocation: InvocationData;
}

/**
 * Framing options for the scaffold.
 *
 * Named `Framing` because `@ably/ai-transport/temporal/workflow` already exports
 * `RunActivityOptions` for something else — per-activity timeouts and retry
 * policies — and a consumer imports from both subpaths.
 */
export interface RunActivityFraming {
  /**
   * How much conversation history to load before the body runs. `'minimal'`
   * loads only what adopting the run requires. `'full'` also pages the whole
   * conversation, which an inference body needs and a tool body does not.
   * Defaults to `'minimal'`.
   */
  history?: 'minimal' | 'full';
}

/** What the scaffold hands a wrapped activity body. */
export interface RunActivityContext<TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /** The adopted run, already loaded. */
  run: AgentRun<TOutput, TProjection, TMessage>;
  /**
   * The step this activity publishes under, already started.
   *
   * One activity is one step, which is what makes a Temporal retry supersede
   * cleanly: the id is derived from the activity id, so the retry re-enters the
   * same step and its output replaces the failed attempt's.
   *
   * Closed for you when the body returns, with the reason derived from what was
   * piped through it — `failed` if any pipe errored, `complete` otherwise. Close
   * it yourself when you need a different reason (`finishStep` does); the
   * scaffold's close is then a no-op, because `end` is idempotent.
   */
  step: RunStep<TOutput>;
  /** The connected session behind the run, for a body that needs `end()`. */
  session: AgentSession<TOutput, TProjection, TMessage>;
  /** The parsed invocation the run serves. */
  invocation: Invocation;
}

/**
 * A wrapped activity body.
 *
 * Annotate the `input` parameter: the returned activity's input type is inferred
 * from it, and omitting the annotation silently widens it to
 * {@link RunActivityInput}.
 * @template TOutput - The codec output event type.
 * @template TProjection - The codec projection type.
 * @template TMessage - The codec message type.
 * @template TActivityInput - The activity's own input type.
 * @template TResult - What the activity returns to the workflow.
 */
export type RunActivityBody<
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
  TActivityInput extends RunActivityInput,
  TResult,
> = (context: RunActivityContext<TOutput, TProjection, TMessage>, input: TActivityInput) => Promise<TResult>;

/**
 * Wrap a body as a Temporal activity, bound to a session scope.
 *
 * The returned function is what a worker registers. It leases a client, connects
 * a session, adopts and loads the run, opens a step, runs the body, closes the
 * step, and tears everything down on both paths.
 * @template TOutput - The codec output event type.
 * @template TProjection - The codec projection type.
 * @template TMessage - The codec message type.
 * @template TActivityInput - The activity's own input type.
 * @template TResult - What the activity returns to the workflow.
 * @param scope - The shared session scope.
 * @param options - Framing options: how much conversation history to load.
 * @param paging - Page size and page cap for a `history: 'full'` drain.
 * @param body - The activity's own work.
 * @returns The activity function.
 */
export const createRunActivity = <
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
  TActivityInput extends RunActivityInput,
  TResult,
>(
  scope: SessionScope<TOutput, TProjection, TMessage>,
  options: RunActivityFraming,
  paging: HistoryPaging,
  body: RunActivityBody<TOutput, TProjection, TMessage, TActivityInput, TResult>,
): ((input: TActivityInput) => Promise<TResult>) => {
  const wantsFullHistory = options.history === 'full';
  const pageSize = paging.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
  const maxPages = paging.maxHistoryPages ?? DEFAULT_MAX_HISTORY_PAGES;

  return async (input: TActivityInput): Promise<TResult> => {
    const signal = Context.current().cancellationSignal;

    return scope.inSession(input.invocation, async ({ session, invocation }) => {
      const run = session.adoptRun(invocation, input.ids, { signal });
      await run.load();

      if (wantsFullHistory) await drainHistory(run.view, pageSize, maxPages);

      // One activity, one step. The id comes from the activity id, so a retry
      // re-enters this step and supersedes the failed attempt's output.
      const step = run.createStep({ stepId: stepIdFor(input.ids.invocationId) });
      await step.start();

      const result = await body({ run, step, session, invocation }, input);

      // Reached only on a clean return: a throw leaves the step open so a retry
      // has something to supersede. A no-op when the body already closed the
      // step to set its own reason, since `end` is idempotent.
      await step.end();
      return result;
    });
  };
};
