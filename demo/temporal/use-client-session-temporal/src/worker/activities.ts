/**
 * Temporal activities that own every I/O side effect of a chat turn:
 * opening the run (`openRun` — createRun + start, no inference), driving each
 * inference (`runInferenceStep`, including the first), running a single server
 * tool (`runToolStep`), and a workflow-level `cleanupRun` for catch-block
 * cleanup.
 *
 * Each activity is fresh-process safe: it constructs its own `Ably.Realtime`
 * and `AgentSession`, does its work, publishes its terminal (`ai-run-end` /
 * `ai-run-suspend`) inline in the same session, then closes.
 *
 * Common boilerplate — `safeSessionDetach`, `safeSessionEnd`,
 * `stripToolExecutes`, `pendingToolCalls`, `stepIdFor`, `step.send` —
 * lives in the SDK across three subpaths:
 *
 *   - `@ably/ai-transport`          — safeSessionDetach, safeSessionEnd, step.send (method)
 *   - `@ably/ai-transport/vercel`   — stripToolExecutes, pendingToolCalls
 *   - `@ably/ai-transport/temporal` — stepIdFor
 *
 * The `cleanupRun` activity below and `waitForRunStart` in `route.ts` are
 * demo-local for now — they will move into the SDK once we've refined
 * their shapes.
 *
 * Cancels arrive as `ai-cancel` on the channel; each activity's own
 * `AgentSession` routes them to `run.abortSignal` via the SDK's built-in
 * cancel routing, so no separate listener activity is needed.
 */

import { Context } from '@temporalio/activity';
import Ably from 'ably';
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai';

import type { VercelOutput, VercelProjection } from '@ably/ai-transport/vercel';
import {
  approvedPendingToolCalls,
  createAgentSession,
  pendingToolCalls,
  stripToolExecutes,
  vercelRunOutcome,
} from '@ably/ai-transport/vercel';
import {
  ErrorCode,
  Invocation,
  LogLevel,
  makeLogger,
  type AgentRun,
  type AgentSession,
  type InvocationData,
} from '@ably/ai-transport';
import { stepIdFor } from '@ably/ai-transport/temporal';

import { createModel } from '../app/api/chat/model.js';
import { SYSTEM_PROMPT } from '../app/api/chat/prompt.js';
import { tools } from '../app/api/chat/tools.js';
import { safeSessionDetach, safeSessionEnd } from './safe-session-end.js';
import type { InferenceOutcome, RunIds, ToolCallInfo } from './shared.js';

// Concrete run/session type this file works with — every activity uses the Vercel codec.
type VercelSession = AgentSession<VercelOutput, VercelProjection, UIMessage>;
type VercelAgentRun = AgentRun<VercelOutput, VercelProjection, UIMessage>;
type VercelRunStep = ReturnType<VercelAgentRun['createStep']>;

const logger = makeLogger({
  logLevel: process.env.WORKER_LOG_LEVEL === 'trace' ? LogLevel.Trace : LogLevel.Debug,
});

const ABLY_KEY = (): string => {
  const key = process.env.ABLY_API_KEY;
  if (!key) throw new Error('ABLY_API_KEY is not set');
  return key;
};

const ABLY_ENDPOINT = (): string | undefined => process.env.ABLY_ENDPOINT;

const makeAbly = (): Ably.Realtime =>
  new Ably.Realtime({
    key: ABLY_KEY(),
    ...(ABLY_ENDPOINT() ? { endpoint: ABLY_ENDPOINT() } : {}),
  });

// -----------------------------------------------------------------------------
// openRun — createRun + start, and nothing else. It publishes the opening event
// (`ai-run-start` for a fresh run, `ai-run-resume` for a continuation) and
// returns the run's ids. It deliberately does NOT run the first inference: that
// is a separate `runInferenceStep` the workflow drives, so an inference failure
// retries the inference alone and never re-opens (re-publishes the opening event
// for) the run. Keeping the two apart also means openRun's ids reach the
// workflow before any inference runs, so a later inference failure past retries
// still has ids to hand `cleanupRun` — the run gets ended 'error' instead of
// being orphaned active.
//
// Retry-safe: the run id is pinned to the Temporal workflowId (see the createRun
// call), so a fresh-process retry of openRun re-enters the same run — it never
// opens a second, parallel run.
// -----------------------------------------------------------------------------

export async function openRun(input: { invocation: InvocationData; invocationId: string }): Promise<RunIds> {
  const cancelSignal = Context.current().cancellationSignal;
  const ably = makeAbly();
  let session: VercelSession | undefined;
  try {
    session = createAgentSession({ client: ably, channelName: input.invocation.sessionName, logger });
    await session.connect();

    const run = session.createRun(Invocation.fromJSON(input.invocation), {
      invocationId: input.invocationId,
      // Stable run id, straight from the framework: invocationId IS the Temporal
      // workflowId, constant across activity and workflow retries. A fresh-process
      // retry of openRun then re-enters the SAME run rather than minting a new
      // UUID and opening a parallel one — the SDK's durable-execution contract for
      // RunRuntime.runId. The retry's ai-run-start folds idempotently onto the
      // existing run node (first startSerial wins). Continuations ignore this:
      // their run id comes from the trigger's wire headers, so it only pins the
      // fresh-run case.
      runId: input.invocationId,
      signal: cancelSignal,
    });

    // Load the conversation history.
    while (run.view.hasOlder()) {
      await run.view.loadOlder();
    }

    // Start the run, including locating the trigger event and publishing the start.
    // The trigger event could be received live, or more likely it will be in history.
    // The above calls to load conversation history using view.loadOlder give access
    // to the trigger event from history. This method will block without publishing
    // the run start until the trigger event is located — so a retry that fails to
    // locate the trigger throws before publishing, leaving no orphaned run.
    await run.start();

    const ids: RunIds = {
      runId: run.runId,
      invocationId: run.invocationId,
      triggerEventId: input.invocation.inputEventId,
    };

    // detach (not end): the run is deliberately left active so the workflow's
    // first runInferenceStep can adopt it. session.end() would publish
    // `ai-run-end` and mark the run terminal.
    await session.detach();

    return ids;
  } catch (error) {
    // Detach (not end) on error: the activity may be retried by Temporal.
    // Ending would publish `ai-run-end` and mark the run terminal, so a
    // retry's `run.start()` would republish onto a terminal run.
    await safeSessionDetach(session);
    throw error;
  } finally {
    ably.close();
  }
}

async function _publishRunTerminal(run: VercelAgentRun, outcome: InferenceOutcome): Promise<void> {
  switch (outcome.kind) {
    case 'suspend':
      await run.suspend();
      return;
    case 'server-tools':
      // The only non-terminal outcome — nothing to publish; the workflow loops
      // with a follow-up inference after its tool steps. (Client steering is
      // handled inside the inference activity, never surfaced to the workflow.)
      return;
    case 'error':
      // complete / cancelled / error all pass straight through to run.end. The
      // outcome.kind values were named to align with `RunEndReason` so the caller
      // doesn't have to translate.
      await run.end({
        reason: 'error',
        error: new Ably.ErrorInfo(outcome.errorMessage, ErrorCode.StreamError, 500),
      });
      return;
    default:
      // publish the terminal reason (complete / cancelled)
      await run.end({ reason: outcome.kind });
  }
}

// -----------------------------------------------------------------------------
// runInferenceStep — ONE turn's inference, published as exactly one SDK step.
// Drives every inference in the turn, first and follow-ups alike: it adopts the
// run openRun (or a prior step) left active, loads it, and runs the model.
// Client steering (a follow-up user-message folded into the active run while we
// stream) loops another inference pass into the SAME step inside this activity,
// rather than round-tripping through the workflow. One step per activity keeps
// the retry deterministic — a retry re-runs the turn under the same stepId and
// supersedes its prior attempt's output. Server tools have their `execute`
// stripped so the AI SDK stops after the call and we drive the tool exec via
// runToolStep.
//
// Resume-visibility race: when the turn is a continuation, openRun published
// `ai-run-resume` on its own session and detached. This fresh session's
// `run.load()` pages channel history to status-gate the run, and may read the
// pre-resume `ai-run-suspend` before the `ai-run-resume` has propagated into
// history — tripping load()'s suspended gate. That gate throws BEFORE the model
// is called (no wasted inference, no partial output), and Temporal retries this
// activity; by the retry the resume has folded and load() passes. Merging open
// + first inference into one session used to sidestep this race entirely; the
// split trades that for a cheap, self-healing retry so the two concerns stay
// independently retryable.
// -----------------------------------------------------------------------------

interface StepInput {
  ids: RunIds;
  invocation: InvocationData;
}

export async function runInferenceStep(input: StepInput): Promise<InferenceOutcome> {
  const cancelSignal = Context.current().cancellationSignal;
  const ably = makeAbly();
  let session: VercelSession | undefined;
  try {
    session = createAgentSession({ client: ably, channelName: input.invocation.sessionName, logger });
    await session.connect();

    const run = session.adoptRun(
      { runId: input.ids.runId, invocationId: input.ids.invocationId, triggerEventId: input.ids.triggerEventId },
      { signal: cancelSignal },
    );

    await run.load();

    // Load history for the LLM conversation.
    while (run.view.hasOlder()) await run.view.loadOlder();

    const outcome = await _runInferenceStep(run, stepIdFor(input.ids.invocationId));

    await _publishRunTerminal(run, outcome);
    // detach (not end): see openRun for why we don't want session.end() here.
    await session.detach();

    return outcome;
  } catch (error) {
    // Detach on error — see openRun for why we don't end the run here.
    await safeSessionDetach(session);
    throw error;
  } finally {
    ably.close();
  }
}

// One inference turn for the activity, published as a single SDK step. Callers
// ready the run handle (via createRun or adoptRun) and drain history first — the
// passes read run.view.
//
// The pre-check dispatches a just-approved server tool before any model call.
// Otherwise this opens ONE step and runs the triggering input's inference pass
// into it, then loops another inference pass into the SAME step for each
// steering message a client folded into the run while we streamed: after a
// `complete` pass, `run.hasInput()` reports (and drains) the pending steering
// message, and the next pass answers it. Each pass's `step.pipe` stamps the
// steering message it drained as a consumed `steer-codec-message-ids`, so the
// client's steering outcome resolves consumed.
// Non-`complete` outcomes (server-tools / suspend / cancelled / error) end the
// loop and route the run on their own.
//
// The stepId is the activity's canonical (deterministic) id, so a retry re-runs
// the whole turn under the same id and supersedes its prior attempt's output.
async function _runInferenceStep(run: VercelAgentRun, stepId: string): Promise<InferenceOutcome> {
  // Pre-check: if this invocation was triggered by a `tool-approval-response`
  // (approved=true), the last assistant's tool part is in
  // `approval-responded` state and the framework owes it an output.
  // Dispatch it as a server-tools step now, before opening a step or calling
  // the model — the LLM would otherwise see an open `tool_use` with no matching
  // `tool_result` and reject. Only match `approval-responded` here (not
  // `input-available`) so this branch doesn't race with the post-`streamText`
  // classification below, which is where a fresh call the model just emitted is
  // handled.
  const approvedServerCalls = _filterServerToolCalls(approvedPendingToolCalls(run.messages));
  if (approvedServerCalls.length > 0) {
    return { kind: 'server-tools', serverToolCalls: approvedServerCalls };
  }

  const step = run.createStep({ stepId });
  await step.start();

  // Run the triggering input's pass, then loop another pass into this same step
  // for each steering message that folded in while the previous pass streamed.
  // hasInput() gates every pass — including the first, so a run cancelled before
  // any inference skips the loop entirely — and only a `complete` pass can be
  // steered; the others route the run on their own. `outcome` is unset until the
  // first pass runs, so the guard reads it null-safely.
  let outcome: InferenceOutcome | undefined;
  while ((!outcome || outcome.kind === 'complete') && run.hasInput()) {
    outcome = await _runInferencePass(run, step);
  }

  // If the run was already cancelled before the first pass, hasInput() was false
  // and no pass ran — treat that as a cancellation.
  const finalOutcome: InferenceOutcome = outcome ?? { kind: 'cancelled' };

  // Close the step with the reason the final pass implies (a piped stream error
  // already marks it failed; the empty-conversation guard has no pipe, so pass
  // the reason explicitly).
  await step.end({
    reason: finalOutcome.kind === 'error' ? 'failed' : finalOutcome.kind === 'cancelled' ? 'cancelled' : 'complete',
  });

  console.log('[inference] outcome', { stepId, kind: finalOutcome.kind });
  return finalOutcome;
}

// One inference pass into an already-open step: streamText + pipe, then classify
// the outcome. Server tools have their `execute` stripped so the AI SDK stops
// after the call and the workflow drives the tool via runToolStep.
async function _runInferencePass(run: VercelAgentRun, step: VercelRunStep): Promise<InferenceOutcome> {
  const conversation = run.view.getMessages().map((m) => m.message);
  if (conversation.length === 0) {
    // Defensive: guards against a cross-activity tree hydration edge case where
    // the view's branch-source returns no messages after multiple resume cycles.
    // Treat this as a stop so the workflow ends the run cleanly instead of
    // dying inside streamText with 'messages must not be empty'.
    console.warn('[inference] conversation is empty — ending run to avoid crash');
    return { kind: 'error', errorMessage: 'conversation drain returned no messages' };
  }

  const result = streamText({
    model: createModel(),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(conversation),
    tools: stripToolExecutes(tools),
    abortSignal: run.abortSignal,
    // The workflow (and the steering loop above) drive multi-step: this call
    // must not loop.
    stopWhen: stepCountIs(1),
  });

  const pipeResult = await step.pipe(result.toUIMessageStream());
  const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
  if (outcome.reason === 'error') return { kind: 'error', errorMessage: outcome.error.message };
  if (outcome.reason === 'cancelled') return { kind: 'cancelled' };
  if (outcome.reason === 'complete') return { kind: 'complete' };

  // Suspend outcome — classify: fresh server-tool calls (have `execute` in
  // the registry) become server-tool activities; anything else (client
  // tools, approval-requested tools) suspends the run for the client to
  // resolve. `pendingToolCalls` matches `input-available` only, so a
  // just-approved call that landed during this activity's `streamText` is
  // NOT caught here — the follow-up workflow spawned by the
  // `tool-approval-response` handles it via the pre-check above.
  const serverToolCalls = _filterServerToolCalls(pendingToolCalls(run.messages));
  if (serverToolCalls.length > 0) {
    return { kind: 'server-tools', serverToolCalls };
  }

  return { kind: 'suspend' };
}

// Narrow the SDK's `PendingToolCall[]` down to the ones whose `execute` lives
// in the server registry, in the shape the workflow needs to dispatch a
// `runToolStep`.
function _filterServerToolCalls(
  calls: readonly { toolCallId: string; toolName: string; input: unknown }[],
): ToolCallInfo[] {
  return calls
    .filter((call) => typeof (tools as Record<string, { execute?: unknown }>)[call.toolName]?.execute === 'function')
    .map((call) => ({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }));
}

// -----------------------------------------------------------------------------
// runToolStep — execute one server tool and publish its result as a single
// tool-output-available chunk on its own SDK step. On failure it throws so
// Temporal retries the activity under the same activityId (== stepId), which
// supersedes the failed attempt's channel output.
// -----------------------------------------------------------------------------

export async function runToolStep(input: StepInput & { toolCall: ToolCallInfo }): Promise<void> {
  const stepId = stepIdFor(input.ids.invocationId);
  const cancelSignal = Context.current().cancellationSignal;
  const ably = makeAbly();

  let session: VercelSession | undefined;
  try {
    session = createAgentSession({ client: ably, channelName: input.invocation.sessionName, logger });
    await session.connect();

    const run = session.adoptRun(
      { runId: input.ids.runId, invocationId: input.ids.invocationId, triggerEventId: input.ids.triggerEventId },
      { signal: cancelSignal },
    );
    await run.load();

    const step = run.createStep({ stepId });
    await step.start();

    // Execute the tool. Throws propagate through Temporal for retry; the
    // outer catch below runs session.end() as a safety net so a permanent
    // failure doesn't leave the run active with a pending tool call.
    const tool = (tools as Record<string, { execute?: (input: unknown) => Promise<unknown> }>)[input.toolCall.toolName];
    if (!tool?.execute) throw new Error(`tool '${input.toolCall.toolName}' has no execute`);
    const output = await tool.execute(input.toolCall.input);

    await step.send({
      type: 'tool-output-available',
      toolCallId: input.toolCall.toolCallId,
      output,
    });
    await step.end();
    // detach (not end): the run is deliberately left active so the follow-up
    // runInferenceStep can adopt it.
    await session.detach();
  } catch (error) {
    // Detach on error: `tool.execute()` throws are typically retryable
    // (Temporal will re-run this activity under the same `stepId`, and the
    // retry supersedes the failed attempt's output via the SDK's start-serial
    // supersede semantics). Ending the session would publish `ai-run-end` and
    // mark the run terminal — every retry would then fail with "run is
    // terminal (read-only)". Workflow-level `cleanupRun` marks the run
    // 'error' after retries are truly exhausted.
    await safeSessionDetach(session);
    throw error;
  } finally {
    ably.close();
  }
}

// -----------------------------------------------------------------------------
// cleanupRun — workflow-level failure cleanup. Register on the worker and
// schedule from the workflow's outer catch when an activity has failed past
// its retry policy. Best-effort: adopt the run, status-gate via load(),
// publish `run.end('error')` if still active. Kept demo-local for now —
// this shape will be refined before extracting to the SDK.
// -----------------------------------------------------------------------------

export async function cleanupRun(input: { ids: RunIds; channelName: string; errorMessage?: string }): Promise<void> {
  const ably = makeAbly();
  let session: VercelSession | undefined;
  try {
    session = createAgentSession({ client: ably, channelName: input.channelName, logger });
    await session.connect();

    const run = session.adoptRun(
      {
        runId: input.ids.runId,
        invocationId: input.ids.invocationId,
        triggerEventId: input.ids.triggerEventId,
      },
      {},
    );

    try {
      // load() pages history to locate ai-run-start + the trigger. It
      // status-gates: rejects if the run is already suspended (client will
      // resume) or terminal (already ended). Either way, nothing to clean up.
      await run.load();
    } catch {
      await session.detach();
      return;
    }

    await run.end({
      reason: 'error',
      error: new Ably.ErrorInfo(input.errorMessage ?? 'workflow failed', ErrorCode.StreamError, 500),
    });
    await session.detach();
  } catch (error) {
    // safeSessionEnd (not detach) here — cleanupRun is the workflow-level
    // terminal path (retries exhausted), so ending open runs is the intent.
    await safeSessionEnd(session);
    throw error;
  } finally {
    ably.close();
  }
}
