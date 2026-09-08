/**
 * Worker-side helpers for the activities an application writes.
 *
 * Every activity runs in a fresh process, so each one builds its own Ably
 * client and agent transport, does its work, and tears both down. These
 * helpers own that lifecycle, layered one on the next:
 *
 *   - `withAgentTransport` hands the body a connected transport on the
 *     invocation's channel and closes it afterwards;
 *   - `withRun` does the same and also opens or adopts a run, handing the body
 *     the run and its identity;
 *   - `withStep` adopts a run and wraps the body in one step keyed on the
 *     Temporal activity id, so a retry of the activity supersedes the failed
 *     attempt's output.
 *
 * Closing a transport publishes nothing: a run an activity leaves open stays
 * open on the wire for a later activity to re-enter. The plugin's own framing
 * activities are built on the same helpers.
 */

import { Context } from '@temporalio/activity';
import * as Ably from 'ably';

import { channelAgent } from '../core/agent.js';
import type { WireCodec } from '../core/codec/types.js';
import { createAgentTransport } from '../core/transport/agent-transport.js';
import { DEFAULT_HISTORY_PAGE_SIZE } from '../core/transport/history-pager.js';
import { Invocation, type InvocationData } from '../core/transport/invocation.js';
import type {
  AgentRunTransport,
  AgentTransport,
  OpenRunHooks,
  RunIdentity,
  RunStepTransport,
} from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import { beat, withHeartbeat } from './heartbeat.js';
import type { AdoptRunInput, OpenRunInput } from './workflow/activity-types.js';

/**
 * Configuration for the worker-side helpers. The same object configures
 * {@link createAblyTransportPlugin}, so an application builds it once and
 * passes it to both.
 */
export interface ActivityHelpersOptions<TInput, TOutput> {
  /** The codec the transports encode with. */
  codec: WireCodec<TInput, TOutput>;
  /**
   * Builds the Ably client for one activity. Called once per activity
   * invocation; the returned client is closed before the activity returns.
   *
   * No echo requirement: every publish is confirmed from the acknowledgement,
   * so `echoMessages: false` is fine.
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
   * `cancellationSignal` these helpers pass to the run. A client's own
   * `ai-cancel` message is unaffected, because that arrives over the channel.
   *
   * This is a request, not a guarantee. An activity with no `heartbeatTimeout`
   * in its options must not heartbeat, so the pump stays silent for it whatever
   * this is set to. Set `heartbeatTimeout` in the activity's options to have it
   * beat.
   */
  heartbeat?: boolean;
  /** Most history pages a scan fetches before giving up. Omit to page to channel exhaustion. */
  maxHistoryPages?: number;
  /** Wire-message limit per history page. */
  historyPageSize?: number;
}

/** What {@link ActivityHelpers.withAgentTransport} hands its body. */
export interface AgentTransportContext<TInput, TOutput> {
  /** A connected agent transport on the invocation's channel. Closed once the body settles. */
  transport: AgentTransport<TInput, TOutput>;
  /** The invocation, validated. */
  invocation: Invocation;
}

/** What {@link ActivityHelpers.withRun} hands its body. */
export interface RunContext<TInput, TOutput> extends AgentTransportContext<TInput, TOutput> {
  /** The run, open or adopted. The body publishes its terminal; the helper never ends it. */
  run: AgentRunTransport<TOutput>;
  /** The run's identity, to return from an opening activity or pass to the next one. */
  ids: RunIdentity;
}

/** What {@link ActivityHelpers.withStep} hands its body. */
export interface StepContext<TInput, TOutput> extends RunContext<TInput, TOutput> {
  /** The step this activity publishes as, keyed on the Temporal activity id. Ended by the helper once the body settles. */
  step: RunStepTransport<TOutput>;
}

/**
 * Which run {@link ActivityHelpers.withRun} works on: an `OpenRunInput` opens a
 * run for the invocation, an {@link AdoptRunInput} re-enters one already open.
 */
export type RunInput = OpenRunInput | AdoptRunInput;

/**
 * Per-run hooks for {@link ActivityHelpers.withRun} and
 * {@link ActivityHelpers.withStep}: every `OpenRunHooks` member except
 * `signal`, which the helper supplies from the activity's own cancellation.
 */
export interface ActivityRunHooks<TOutput> extends Omit<OpenRunHooks<TOutput>, 'signal'> {
  /**
   * Whether Temporal's cancellation reaches the run. Defaults to true, which
   * passes `Context.current().cancellationSignal` to the run. Pass false for an
   * activity that must finish while its workflow is being cancelled, such as a
   * cleanup arm.
   */
  cancellable?: boolean;
}

/**
 * Run `body` against a connected agent transport on the invocation's channel,
 * then close the transport and its client.
 * @template T - The body's return type.
 * @param invocation - The invocation whose `channelName` is the channel.
 * @param body - The work to run against the transport.
 * @returns Whatever `body` returns.
 * @throws {@link Ably.ErrorInfo} with `InvalidArgument` when the invocation is malformed; nothing is built first.
 */
export type WithAgentTransport<TInput, TOutput> = <T>(
  invocation: InvocationData,
  body: (ctx: AgentTransportContext<TInput, TOutput>) => Promise<T>,
) => Promise<T>;

/**
 * Everything {@link WithAgentTransport} does, then open or adopt a run and hand
 * it to `body`.
 *
 * An `OpenRunInput` opens: the helper locates the trigger in channel history,
 * opens the run pinned to the invocation id, and awaits the opening publish. An
 * {@link AdoptRunInput} adopts, which publishes nothing. Either way the body
 * publishes the run's terminal itself; the helper never ends the run.
 *
 * Must run inside a Temporal activity: the cancellation signal comes from
 * `Context.current()`.
 */
export interface WithRun<TInput, TOutput> {
  /**
   * @template T - The body's return type.
   * @param input - Which run to open or adopt.
   * @param body - The work to run against the run.
   * @returns Whatever `body` returns.
   * @throws {@link Ably.ErrorInfo} with `NotFound` when opening and the trigger is not in history, and with `OperationCancelled` when the activity was cancelled before the run could open.
   */
  <T>(input: RunInput, body: (ctx: RunContext<TInput, TOutput>) => Promise<T>): Promise<T>;
  /**
   * @template T - The body's return type.
   * @param input - Which run to open or adopt.
   * @param hooks - Run hooks, and whether Temporal's cancellation reaches the run.
   * @param body - The work to run against the run.
   * @returns Whatever `body` returns.
   * @throws {@link Ably.ErrorInfo} with `NotFound` when opening and the trigger is not in history, and with `OperationCancelled` when the activity was cancelled before the run could open.
   */
  <T>(
    input: RunInput,
    hooks: ActivityRunHooks<TOutput>,
    body: (ctx: RunContext<TInput, TOutput>) => Promise<T>,
  ): Promise<T>;
}

/**
 * Adopt the run and wrap `body` in one step keyed on the Temporal activity id,
 * so a retry of this activity publishes under the same step and supersedes the
 * failed attempt's output.
 *
 * The step ends when the body settles: with a reason derived from what it
 * published when the body returns, and `failed` when the body throws, in which
 * case the body's error is rethrown. A step the body already closed, directly
 * or by ending the run, is left alone. The helper never ends the run.
 *
 * Must run inside a Temporal activity: the step id comes from
 * `Context.current().info.activityId`.
 */
export interface WithStep<TInput, TOutput> {
  /**
   * @template T - The body's return type.
   * @param input - The run to adopt.
   * @param body - The work to run against the step.
   * @returns Whatever `body` returns.
   */
  <T>(input: AdoptRunInput, body: (ctx: StepContext<TInput, TOutput>) => Promise<T>): Promise<T>;
  /**
   * @template T - The body's return type.
   * @param input - The run to adopt.
   * @param hooks - Run hooks, and whether Temporal's cancellation reaches the run.
   * @param body - The work to run against the step.
   * @returns Whatever `body` returns.
   */
  <T>(
    input: AdoptRunInput,
    hooks: ActivityRunHooks<TOutput>,
    body: (ctx: StepContext<TInput, TOutput>) => Promise<T>,
  ): Promise<T>;
}

/**
 * The worker-side helpers, bound to a codec and a client factory by
 * {@link createActivityHelpers}. Plain function properties, so an application
 * destructures the ones it uses.
 */
export interface ActivityHelpers<TInput, TOutput> {
  /** See {@link WithAgentTransport}. */
  withAgentTransport: WithAgentTransport<TInput, TOutput>;
  /** See {@link WithRun}. */
  withRun: WithRun<TInput, TOutput>;
  /** See {@link WithStep}. */
  withStep: WithStep<TInput, TOutput>;
}

/** The two call shapes the run-scoped helpers accept: a body alone, or hooks then a body. */
type HooksAndBody<TOutput, TCtx, T> =
  | [(ctx: TCtx) => Promise<T>]
  | [ActivityRunHooks<TOutput>, (ctx: TCtx) => Promise<T>];

/**
 * Split the optional hooks from the body.
 * @param rest - The trailing arguments as passed.
 * @returns The hooks, defaulting to none, and the body.
 */
const splitHooksAndBody = <TOutput, TCtx, T>(
  rest: HooksAndBody<TOutput, TCtx, T>,
): [ActivityRunHooks<TOutput>, (ctx: TCtx) => Promise<T>] => (rest.length === 1 ? [{}, rest[0]] : rest);

/**
 * The error thrown when the activity was cancelled before it could put the
 * opening event on the channel.
 * @returns The cancellation error.
 */
const activityCancelled = (): Ably.ErrorInfo =>
  new Ably.ErrorInfo('unable to open run; activity cancelled', ErrorCode.OperationCancelled, 400);

/**
 * Build the worker-side helpers, bound to a codec and a client factory.
 *
 * A factory rather than module-level state, so a worker can host more than one
 * configuration and nothing is global.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 * @param options - Codec, client factory, and paging behaviour.
 * @returns The helpers.
 */
export const createActivityHelpers = <TInput, TOutput>(
  options: ActivityHelpersOptions<TInput, TOutput>,
): ActivityHelpers<TInput, TOutput> => {
  const { codec, createClient } = options;
  // Each layer adds its own context, so a transport built inside an activity
  // is distinguishable in the log from any other AgentTransport.
  const logger = options.logger?.withContext({ component: 'ActivityHelpers' });
  const heartbeat = options.heartbeat ?? true;

  /**
   * Per-page heartbeat for the history scans, when enabled. `beat` applies
   * Temporal's own gate, so a page hook on an activity with no heartbeat
   * timeout is a no-op rather than a contract breach.
   */
  const onPage = heartbeat ? beat : undefined;

  /**
   * The hooks handed to `openRun` or `adoptRun`: the caller's, with the
   * activity's cancellation signal added unless the caller opted out.
   * @param hooks - The caller's hooks.
   * @param hooks.cancellable - Whether to add the activity's cancellation signal.
   * @returns The hooks for the transport.
   */
  const runHooks = ({ cancellable = true, ...rest }: ActivityRunHooks<TOutput>): OpenRunHooks<TOutput> => ({
    ...rest,
    ...(cancellable && { signal: Context.current().cancellationSignal }),
  });

  const withAgentTransport = async <T>(
    invocationData: InvocationData,
    body: (ctx: AgentTransportContext<TInput, TOutput>) => Promise<T>,
  ): Promise<T> => {
    // Validated before anything is built, so a malformed invocation never
    // reaches `channels.get`.
    const invocation = Invocation.fromJSON(invocationData);
    logger?.trace('ActivityHelpers.withAgentTransport();', { channelName: invocation.channelName });
    const client = createClient();
    try {
      return await withHeartbeat(heartbeat, async () => {
        // This module resolves the channel itself, so nothing downstream can
        // add the attribution afterwards: without it every event published
        // through the transport goes out unattributed. The mode set stays the
        // caller's business, and the transport's base modes are the default.
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

  /**
   * Open a run for the invocation: locate its trigger, then publish the
   * opening event pinned to the invocation id.
   * @param ctx - The connected transport and the invocation.
   * @param input - The invocation id to pin the run to.
   * @param hooks - The caller's hooks.
   * @returns The run and its identity.
   */
  const openRun = async (
    ctx: AgentTransportContext<TInput, TOutput>,
    input: OpenRunInput,
    hooks: ActivityRunHooks<TOutput>,
  ): Promise<{ run: AgentRunTransport<TOutput>; ids: RunIdentity }> => {
    const { transport, invocation } = ctx;
    const transportHooks = runHooks(hooks);
    // The trigger was published before this process attached, so it sits in
    // channel history. Locate it and no more: this path runs no inference, so
    // it never needs the rest of the conversation. A retry that cannot find it
    // throws before publishing and leaves no orphaned run.
    const located = await transport.locateInput(invocation.inputEventId, {
      ...(transportHooks.signal && { signal: transportHooks.signal }),
      ...(onPage && { onPage }),
      // Bounded on `maxHistoryPages` alone: `historyPageSize` has a
      // transport-side default, so requiring both would silently ignore a
      // caller who set only the bound. `limit` caps the wire messages scanned
      // and is page granular, so the product bounds the pages the scan fetches.
      ...(options.maxHistoryPages !== undefined && {
        limit: options.maxHistoryPages * (options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE),
      }),
    });
    if (!located) {
      logger?.error('ActivityHelpers.withRun(); trigger not found in history', {
        inputEventId: invocation.inputEventId,
      });
      throw new Ably.ErrorInfo(
        `unable to open run; input event ${invocation.inputEventId} not found in channel history`,
        ErrorCode.NotFound,
        404,
      );
    }
    logger?.debug('ActivityHelpers.withRun(); trigger located', {
      inputEventId: invocation.inputEventId,
      serial: located.meta.serial,
    });

    // A cancelled activity must not put a fresh opening event on the channel,
    // and the opening publish is not itself abortable, so the check belongs
    // before the open rather than after it.
    if (transportHooks.signal?.aborted) throw activityCancelled();

    // The located input drives the open: its run-id header references the run
    // a continuation re-enters; without one, a fresh turn opens under the
    // pinned `runId`. That pin is the invocation id, which Temporal holds
    // constant across an activity's retries, so a fresh-process retry
    // re-enters the SAME run instead of minting a new id and opening a
    // parallel one.
    const run = transport.openRun(
      { input: located, runId: input.invocationId, invocationId: input.invocationId },
      transportHooks,
    );
    // `opened` settles with the opening publish's acknowledgement. Awaiting it
    // hands off to the next activity strictly after the open is accepted onto
    // the channel, and fails the activity fast for retry when the publish is
    // refused, rather than stalling to the startToClose timeout. Nothing here
    // reads an echo, so the client need not echo publishes.
    await run.opened;
    logger?.debug('ActivityHelpers.withRun(); run open', { runId: run.runId });
    return { run, ids: { runId: run.runId, invocationId: input.invocationId } };
  };

  /**
   * Re-enter a run already open. Publishes nothing.
   * @param ctx - The connected transport and the invocation.
   * @param input - The run's identity.
   * @param hooks - The caller's hooks.
   * @returns The run and its identity.
   */
  const adoptRun = (
    ctx: AgentTransportContext<TInput, TOutput>,
    input: AdoptRunInput,
    hooks: ActivityRunHooks<TOutput>,
  ): { run: AgentRunTransport<TOutput>; ids: RunIdentity } => {
    const run = ctx.transport.adoptRun(input.ids.runId, { invocationId: input.ids.invocationId }, runHooks(hooks));
    logger?.debug('ActivityHelpers.withRun(); run adopted', {
      runId: input.ids.runId,
      cancellable: hooks.cancellable ?? true,
    });
    return { run, ids: input.ids };
  };

  const withRun = async <T>(
    input: RunInput,
    ...rest: HooksAndBody<TOutput, RunContext<TInput, TOutput>, T>
  ): Promise<T> => {
    const [hooks, body] = splitHooksAndBody(rest);
    logger?.trace(
      'ActivityHelpers.withRun();',
      'ids' in input ? { runId: input.ids.runId } : { invocationId: input.invocationId },
    );
    return withAgentTransport(input.invocation, async (ctx) => {
      const opened = 'ids' in input ? adoptRun(ctx, input, hooks) : await openRun(ctx, input, hooks);
      return body({ ...ctx, ...opened });
    });
  };

  const withStep = async <T>(
    input: AdoptRunInput,
    ...rest: HooksAndBody<TOutput, StepContext<TInput, TOutput>, T>
  ): Promise<T> => {
    const [hooks, body] = splitHooksAndBody(rest);
    return withRun(input, hooks, async (ctx) => {
      // The activity id is stable across Temporal's retries of this activity
      // and unique within the workflow, and one workflow owns each run the
      // plugin opens, so it is the step id: a retry publishes under the same
      // step and supersedes the failed attempt's output.
      const stepId = Context.current().info.activityId;
      const step = ctx.run.createStep({ stepId });
      logger?.trace('ActivityHelpers.withStep();', { runId: ctx.ids.runId, stepId });
      // The body may close the step itself, directly or by ending the run,
      // which auto-closes the active step. `ended` covers both, so the helper
      // only ends a step the body left open.
      try {
        const result = await body({ ...ctx, step });
        if (!step.ended) {
          await step.end();
          logger?.debug('ActivityHelpers.withStep(); step ended', { stepId });
        }
        return result;
      } catch (error) {
        logger?.warn('ActivityHelpers.withStep(); body threw', {
          stepId,
          stepEnded: step.ended,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!step.ended) {
          try {
            await step.end({ reason: 'failed' });
          } catch {
            /* best-effort — the body's error is the one that matters */
          }
        }
        throw error;
      }
    });
  };

  return { withAgentTransport, withRun, withStep };
};
