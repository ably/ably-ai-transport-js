/**
 * The durable activities that make up an AIT turn on Vercel Workflows.
 *
 * Each exported `"use step"` function is one activity — a separate WDK process
 * (a fresh invocation). The uniform envelope every activity runs inside (fresh
 * Ably client + AIT `AgentSession`, teardown, demo telemetry) lives in
 * {@link withActivity}; the bodies below are just the AIT SDK calls that make
 * the durable turn work.
 *
 * The composition is a **driver-owned agent loop** (see `ait-turn.ts`): the
 * workflow owns each model call and each server-tool execution as its own
 * retryable activity, rather than letting the AI SDK's internal multi-step loop
 * run tools inline. So the model call strips server `execute`s
 * ({@link stripToolExecutes}), each inference classifies what the model emitted
 * ({@link pendingToolCalls} / {@link approvedPendingToolCalls}), and the
 * workflow dispatches one {@link toolActivity} per server call before looping a
 * follow-up {@link inferenceActivity}.
 *
 * Each interaction with the session channel is its own activity: {@link openActivity}
 * opens the run (one `ai-run-start` / `ai-run-resume`), then every model call — the
 * first and each follow-up alike — is an {@link inferenceActivity} that adopts the
 * open run, so an inference retry never re-opens (re-publishes the opening of) it.
 *
 * Two rules keep the cross-process lifecycle sound:
 *
 * - **Terminals publish inline.** The activity that produces an outcome
 *   publishes `ai-run-suspend` / `ai-run-end` in its own session before it
 *   returns, so no separately-queued lifecycle activity can race the client's
 *   continuation. (`server-tools` is the only non-terminal outcome — the run is
 *   left active for the next activity to adopt.)
 * - **Retries observe before they redo.** By the time WDK re-runs an activity a
 *   continuation may already have moved the run on, so a retry checks the run's
 *   state on the wire and only redoes genuinely unfinished work — never
 *   clobbering a result that already landed.
 */

import * as Ably from 'ably';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { RetryableError } from 'workflow';
import { ErrorCode, type InvocationData } from '@ably/ai-transport';
import {
  approvedPendingToolCalls,
  pendingToolCalls,
  stripToolExecutes,
  vercelRunOutcome,
  type PendingToolCall,
} from '@ably/ai-transport/vercel';

import { createModel } from '../api/chat/model';
import { tools } from '../api/chat/tools';
import type { FaultMode } from '../lib/fault';
import { withActivity, type WdkAgentRun, type WdkAgentSession } from './activity-runtime';

const SYSTEM_PROMPT = 'You are a helpful assistant running inside a durable Vercel Workflow. Keep replies concise.';

/** The run identity the open activity mints and threads to every later activity of the turn. */
export interface TurnIds {
  /** The run's id — the durable key later activities `adoptRun` by. */
  runId: string;
  /** This turn's invocation id, stamped on every event the turn publishes. */
  invocationId: string;
  /** The event id of the run's triggering input — how an adopting activity locates the run in history. */
  triggerEventId: string;
}

/** One server tool call the inference surfaced for the workflow to dispatch. */
export interface ToolCallInfo {
  /** The tool call's id — stable per call, opaque to the demo. */
  toolCallId: string;
  /** The tool's name (a key in the server `tools` registry). */
  toolName: string;
  /** The tool's parsed input, as the model provided it. */
  input: unknown;
}

/**
 * The outcome an inference returns for the workflow to route on. Terminal kinds
 * (`complete` / `suspend` / `cancelled` / `error`) have already been published
 * on the wire before the activity returned; `server-tools` is the only
 * non-terminal kind — the workflow dispatches its calls, then loops.
 */
export type InferenceOutcome =
  | { kind: 'complete' }
  | { kind: 'suspend' }
  | { kind: 'cancelled' }
  | { kind: 'error'; errorMessage: string }
  | { kind: 'server-tools'; serverToolCalls: ToolCallInfo[] };

// ---------------------------------------------------------------------------
// The activities
// ---------------------------------------------------------------------------

/**
 * OPEN: create the run, publish its opening event — `ai-run-start`, or
 * `ai-run-resume` when the trigger already carries a run id (one activity serves
 * both) — and return the run identity. Nothing more: the first inference is its
 * own {@link inferenceActivity}, so an inference failure retries the inference
 * alone (never re-opening the run), and the ids reach the workflow before any
 * inference runs, so a later inference failure past its retries still has ids to
 * hand {@link cleanupActivity} instead of orphaning the run active.
 *
 * Retry-safe: the runId is pinned to the (replay-stable) workflow run id, so a
 * WDK retry re-enters the SAME run and its duplicate `ai-run-start` folds
 * idempotently onto the existing node (first start-serial wins) — it never opens
 * a parallel run.
 * @param invocationData - The invocation pointer the client POSTed.
 * @param workflowRunId - The WDK workflow run id (stable across replays).
 */
export async function openActivity(invocationData: InvocationData, workflowRunId: string): Promise<TurnIds> {
  'use step';
  return withActivity(invocationData, workflowRunId, 'open', async ({ session, invocation, reportAitRun }) => {
    const invocationId = `inv:${workflowRunId}`;
    const run = session.createRun(invocation, { runId: `run:${workflowRunId}`, invocationId });

    // Cold start: the trigger was published before this fresh process attached,
    // so drain history to fold it in; `start()` then reads its headers to open
    // (fresh) or resume (continuation) the run.
    while (run.view.hasOlder()) await run.view.loadOlder();
    await run.start();

    reportAitRun(run.runId);
    return { runId: run.runId, invocationId, triggerEventId: invocation.inputEventId };
  });
}

/**
 * INFERENCE: adopt the open run and run one model call, publishing its terminal
 * inline. Drives every inference — the first (right after {@link openActivity})
 * and each follow-up, which the workflow schedules after server-tool activities
 * so the model sees their published outputs.
 *
 * `load()` status-gates the run and throws BEFORE the model call if it reads a
 * stale `suspended` (a continuation's `ai-run-resume` not yet folded); the throw
 * costs no inference, and a WDK retry — a fresh process that attaches once the
 * resume has folded — passes. On a retry {@link observeTakenOver} bails if a
 * continuation has since taken the run over, so a slow retry never re-runs the
 * model and clobbers the continuation's result.
 * @param invocationData - The invocation pointer (carries the channel name).
 * @param ids - The run identity from {@link openActivity}.
 * @param workflowRunId - The WDK workflow run id.
 * @param fault - Optional fault to inject (the workflow passes it only to the first inference).
 */
export async function inferenceActivity(
  invocationData: InvocationData,
  ids: TurnIds,
  workflowRunId: string,
  fault?: FaultMode,
): Promise<InferenceOutcome> {
  'use step';
  return withActivity(
    invocationData,
    workflowRunId,
    'inference',
    async ({ session, stepId, attempt, reportAitRun }) => {
      reportAitRun(ids.runId);
      const run = session.adoptRun(ids);
      await run.load({ timeoutMs: 15_000 });
      while (run.view.hasOlder()) await run.view.loadOlder();

      // On a retry, a continuation may already have taken the run over — return
      // what's on the wire and publish nothing (see observeTakenOver).
      const takenOver = attempt > 1 ? observeTakenOver(run, session, ids.runId, ids.invocationId) : undefined;
      if (takenOver) return takenOver;

      const outcome = await runInference(run, { stepId, attempt, fault });
      await publishTerminal(run, outcome);
      return outcome;
    },
  );
}

/**
 * TOOL: execute ONE server tool and publish its result as a single
 * `tool-output-available` message under its own AIT step. A throw retries under
 * the same stepId, so the retry's output supersedes the failed attempt's.
 * @param invocationData - The invocation pointer (carries the channel name).
 * @param ids - The run identity from {@link openActivity}.
 * @param workflowRunId - The WDK workflow run id.
 * @param toolCall - The server tool call to execute.
 */
export async function toolActivity(
  invocationData: InvocationData,
  ids: TurnIds,
  workflowRunId: string,
  toolCall: ToolCallInfo,
): Promise<void> {
  'use step';
  await withActivity(invocationData, workflowRunId, 'tool', async ({ session, stepId, reportAitRun }) => {
    reportAitRun(ids.runId);
    const run = session.adoptRun(ids);
    await run.load({ timeoutMs: 15_000 });

    const step = run.createStep({ stepId });
    await step.start();
    const output = await executeServerTool(toolCall);
    await step.send({ type: 'tool-output-available', toolCallId: toolCall.toolCallId, output });
    await step.end();
  });
}

/**
 * CLEANUP: the workflow-level failure terminal, scheduled from the workflow's
 * catch once an activity has failed past its retry policy. Publishes
 * `ai-run-end{error}` so observers' streams close instead of hanging; a
 * `load()` rejection means the run is already suspended or terminal — nothing
 * to clean up. Best-effort: one attempt, no retries.
 * @param invocationData - The invocation pointer (carries the channel name).
 * @param ids - The run identity from {@link openActivity}.
 * @param workflowRunId - The WDK workflow run id.
 * @param errorMessage - The failure to stamp on the run terminal.
 */
export async function cleanupActivity(
  invocationData: InvocationData,
  ids: TurnIds,
  workflowRunId: string,
  errorMessage: string,
): Promise<void> {
  'use step';
  await withActivity(invocationData, workflowRunId, 'cleanup', async ({ session, reportAitRun }) => {
    reportAitRun(ids.runId);
    const run = session.adoptRun(ids);
    try {
      await run.load({ timeoutMs: 15_000 });
    } catch {
      return;
    }
    await run.end({ reason: 'error', error: new Ably.ErrorInfo(errorMessage, ErrorCode.StreamError, 500) });
  });
}

// Cleanup is best-effort and must not cascade: one attempt, no retries.
cleanupActivity.maxRetries = 0;

// ---------------------------------------------------------------------------
// The shared inference core
// ---------------------------------------------------------------------------

/**
 * One model call, published as one AIT step, classified into an
 * {@link InferenceOutcome}. Callers ready the run (create + start, or adopt +
 * load) and drain history first.
 */
async function runInference(
  run: WdkAgentRun,
  opts: { stepId: string; attempt: number; fault?: FaultMode },
): Promise<InferenceOutcome> {
  // A `tool-approval-response` just landed: the approved call's output is owed,
  // but feeding the approval pair back through the model is unreliable on real
  // providers. Dispatch the approved call directly instead of re-asking.
  const approved = filterServerToolCalls(approvedPendingToolCalls(run.messages));
  if (approved.length > 0) return { kind: 'server-tools', serverToolCalls: approved };

  // A prior (dead) attempt of this activity already streamed tool calls, which
  // the client may have answered by now. Route those instead of re-running the
  // model, so recovery completes the bookkeeping without redoing finished work.
  const unresolved = pendingToolCalls(run.messages);
  if (unresolved.length > 0) {
    const server = filterServerToolCalls(unresolved);
    return server.length > 0 ? { kind: 'server-tools', serverToolCalls: server } : { kind: 'suspend' };
  }

  const step = run.createStep({ stepId: opts.stepId });
  await step.start();

  const conversation = run.view.getMessages().map((entry) => entry.message);
  if (conversation.length === 0) {
    // Never hand streamText an empty prompt ("messages must not be empty").
    await step.end({ reason: 'failed' });
    return { kind: 'error', errorMessage: 'conversation drain returned no messages' };
  }

  const result = streamText({
    model: createModel(),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(conversation),
    // The workflow drives multi-step, so strip server `execute`s: the model
    // emits its tool calls and stops rather than running them inline.
    tools: stripToolExecutes(tools),
    stopWhen: stepCountIs(1),
    abortSignal: run.abortSignal,
  });
  const pipeResult = await step.pipe(result.toUIMessageStream());

  injectFault(opts.fault, opts.attempt);

  const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
  await step.end(outcome.reason === 'error' ? { reason: 'failed' } : undefined);

  if (outcome.reason === 'error') return { kind: 'error', errorMessage: outcome.error.message };
  if (outcome.reason === 'cancelled') return { kind: 'cancelled' };
  if (outcome.reason === 'complete') return { kind: 'complete' };

  // The model stopped on tool calls: server calls (execute in the registry)
  // become tool activities; anything else (client tools, approval-gated tools)
  // suspends the run for the client to resolve.
  const server = filterServerToolCalls(pendingToolCalls(run.messages));
  return server.length > 0 ? { kind: 'server-tools', serverToolCalls: server } : { kind: 'suspend' };
}

/** Publish the run lifecycle event an outcome implies (`server-tools` publishes nothing). */
async function publishTerminal(run: WdkAgentRun, outcome: InferenceOutcome): Promise<void> {
  switch (outcome.kind) {
    case 'suspend':
      await run.suspend();
      return;
    case 'server-tools':
      return;
    case 'error':
      await run.end({ reason: 'error', error: new Ably.ErrorInfo(outcome.errorMessage, ErrorCode.StreamError, 500) });
      return;
    default:
      await run.end({ reason: outcome.kind });
  }
}

/** Narrow pending tool calls to the server-executed ones the workflow dispatches as tool activities. */
function filterServerToolCalls(calls: readonly PendingToolCall[]): ToolCallInfo[] {
  return calls
    .filter((call) => typeof tools[call.toolName]?.execute === 'function')
    .map((call) => ({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }));
}

/** Look up and run one server tool from the registry by the model-provided name + input. */
function executeServerTool(toolCall: ToolCallInfo): Promise<unknown> {
  // CAST: registry lookup by model-provided name — a trust boundary; the
  // workflow only dispatches calls filterServerToolCalls confirmed have execute.
  const tool = (tools as Record<string, { execute?: (input: unknown) => Promise<unknown> }>)[toolCall.toolName];
  if (!tool?.execute) throw new Error(`tool '${toolCall.toolName}' has no execute`);
  return tool.execute(toolCall.input);
}

/**
 * Idempotent-retry guard for an inference retry. By the time WDK re-runs an
 * inference, a continuation may already have resumed or finished the run — a
 * streamed tool call is answered the moment its parts arrive, well within the
 * retry backoff. Re-inferring would race that continuation and clobber its
 * result, so observe first and only proceed if the run is still ours to drive.
 * @returns the observed outcome to short-circuit with, or undefined to proceed.
 */
function observeTakenOver(
  run: WdkAgentRun,
  session: WdkAgentSession,
  runId: string,
  invocationId: string,
): InferenceOutcome | undefined {
  const observed = run.view.run(runId);
  if (!observed) return undefined;
  const lastResume = session.tree.getRunNode(runId)?.lastResumeInvocationId;
  const resumedByOther = lastResume !== undefined && lastResume !== invocationId;
  if (observed.status === 'active' && !resumedByOther) return undefined;
  if (observed.status === 'error') return { kind: 'error', errorMessage: observed.error.message };
  if (observed.status === 'complete' || observed.status === 'cancelled') return { kind: observed.status };
  return { kind: 'suspend' };
}

/**
 * Demo control: on an activity's FIRST attempt, throw so WDK retries it and the
 * retry supersedes the dead attempt's output — the durable-retry story on
 * demand. `fail-once` throws a WDK {@link RetryableError} (a graceful, expected
 * transient failure, with a backoff); `crash` throws a plain Error (an
 * unhandled bug / worker crash, retried on WDK's default schedule).
 */
function injectFault(fault: FaultMode | undefined, attempt: number): void {
  if (attempt !== 1) return;
  if (fault === 'fail-once') throw new RetryableError('injected fault: fail once', { retryAfter: '1s' });
  if (fault === 'crash') throw new Error('injected fault: simulated worker crash');
}
