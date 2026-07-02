/**
 * Temporal activities that own every I/O side effect of a chat turn:
 * opening the run + first inference (`openRun`), driving each follow-up
 * inference (`runInferenceStep`), running a single server tool
 * (`runToolStep`), and a workflow-level `cleanupRun` for catch-block cleanup.
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
import type { InferenceOutcome, OpenRunResult, RunIds, ToolCallInfo } from './shared.js';

// Concrete run/session type this file works with — every activity uses the Vercel codec.
type VercelSession = AgentSession<VercelOutput, VercelProjection, UIMessage>;
type VercelAgentRun = AgentRun<VercelOutput, VercelProjection, UIMessage>;

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

export async function openRun(input: { invocation: InvocationData; invocationId: string }): Promise<OpenRunResult> {
  const cancelSignal = Context.current().cancellationSignal;
  const ably = makeAbly();
  let session: VercelSession | undefined;
  try {
    session = createAgentSession({ client: ably, channelName: input.invocation.sessionName, logger });
    await session.connect();

    const run = session.createRun(Invocation.fromJSON(input.invocation), {
      invocationId: input.invocationId,
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
    // the run start until the trigger event is located.
    await run.start();

    const outcome = await _runInferenceStep(run, stepIdFor(input.invocationId));

    await _publishRunTerminal(run, outcome);

    // detach (not end): _publishRunTerminal already ended the run for terminal
    // outcomes; for `server-tools` the run is deliberately left active so the
    // follow-up runToolStep + runInferenceStep can adopt it. session.end()
    // would incorrectly end the still-open run as 'cancelled' in the
    // server-tools case.
    await session.detach();

    const ids: RunIds = {
      runId: run.runId,
      invocationId: run.invocationId,
      triggerEventId: input.invocation.inputEventId,
    };

    return { ids, outcome };
  } catch (error) {
    // Detach (not end) on error: the activity may be retried by Temporal.
    // Ending would publish `ai-run-end` and mark the run terminal, so a
    // retry's `run.load()` would reject with "run is terminal (read-only)".
    // Workflow-level `cleanupRun` marks the run 'error' after retries are
    // truly exhausted.
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
      // server-tools is the only non-terminal outcome — nothing to publish; the
      // workflow will loop with a follow-up inference.
      return;
    case 'error':
      // complete / cancelled / error all pass straight through to run.end. The
      // outcome.kind values were named to align with `RunEndReason` so the caller
      // doesn't have to translate.
      await run.end({
        reason: 'error',
        error: new Ably.ErrorInfo(outcome.errorMessage, 104000, 500),
      });
      return;
    default:
      // publish the terminal reason (complete / cancelled)
      await run.end({ reason: outcome.kind });
  }
}

// -----------------------------------------------------------------------------
// runInferenceStep — one LLM inference call, published as one SDK step.
// Server tools have their `execute` stripped so the AI SDK stops after the
// call and we drive the tool exec via runToolStep. The activity returns the
// outcome the workflow routes on.
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

// Shared inference core: create + open a step, streamText+pipe, close the
// step, classify the outcome. Callers ready the run handle (via createRun or
// adoptRun) and drain history first — this function reads run.view.
async function _runInferenceStep(run: VercelAgentRun, stepId: string): Promise<InferenceOutcome> {
  // Pre-check: if this invocation was triggered by a `tool-approval-response`
  // (approved=true), the last assistant's tool part is in
  // `approval-responded` state and the framework owes it an output.
  // Dispatch it as a server-tools step now, before calling the model — the
  // LLM would otherwise see an open `tool_use` with no matching `tool_result`
  // and reject. Only match `approval-responded` here (not `input-available`)
  // so this branch doesn't race with the post-`streamText` classification
  // below, which is where a fresh call the model just emitted is handled.
  const approvedServerCalls = _filterServerToolCalls(approvedPendingToolCalls(run.messages));
  if (approvedServerCalls.length > 0) {
    return { kind: 'server-tools', serverToolCalls: approvedServerCalls };
  }

  const activityId = stepId;

  const step = run.createStep({ stepId });
  await step.start();

  const conversation = run.view.getMessages().map((m) => m.message);
  if (conversation.length === 0) {
    // Defensive: guards against a cross-activity tree hydration edge case where
    // the view's branch-source returns no messages after multiple resume cycles.
    // Treat this as a stop so the workflow ends the run cleanly instead of
    // dying inside streamText with 'messages must not be empty'.
    console.warn('[inference] conversation is empty — ending run to avoid crash');
    await step.end({ reason: 'failed' });
    return { kind: 'error', errorMessage: 'conversation drain returned no messages' };
  }

  const result = streamText({
    model: createModel(),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(conversation),
    tools: stripToolExecutes(tools),
    abortSignal: run.abortSignal,
    // The workflow drives multi-step: this call must not loop.
    stopWhen: stepCountIs(1),
  });

  const pipeResult = await step.pipe(result.toUIMessageStream());
  const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
  await step.end();

  console.log('[inference] outcome', { activityId, reason: outcome.reason });
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
      error: new Ably.ErrorInfo(input.errorMessage ?? 'workflow failed', 104000, 500),
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
