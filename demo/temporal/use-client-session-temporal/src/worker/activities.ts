/**
 * The APPLICATION's Temporal activities: driving each inference
 * (`runInferenceStep`, including the first) and running a single server tool
 * (`runToolStep`). This is the half of a durable agent the SDK cannot own — the
 * model, the system prompt, the tool registry, `stopWhen`, and the steering
 * policy are all decisions this app makes.
 *
 * The run's FRAMING — opening it, and closing it when a turn fails — comes from
 * the SDK's Temporal plugin, registered in `index.ts`. Those activities carry no
 * application logic, so there is nothing here to write.
 *
 * `ablyTransport.activity(...)` wraps each body with the rest: it leases a
 * connection from the worker's pool, connects a session, adopts the run the
 * workflow is threading, loads it, and tears all of that down whether the body
 * returns or throws. Two things it does are worth knowing. It adopts with the
 * activity's cancellation signal and heartbeats while the body runs, and both are
 * needed together — Temporal reports a cancellation only in the response to a
 * heartbeat, so without the heartbeat a `temporal workflow cancel` would never
 * reach the model. And it detaches rather than ends the session, which is what
 * makes a Temporal retry work: ending would mark the run terminal and the retry
 * would have nothing to publish onto.
 *
 * Boilerplate lives in the SDK across three subpaths:
 *
 *   - `@ably/ai-transport`          — step.send (method)
 *   - `@ably/ai-transport/vercel`   — finishRun, finishStep, stripToolExecutes, pendingToolCalls
 *   - `@ably/ai-transport/temporal` — the plugin and its activity scaffold
 *
 * Cancels from the browser need none of the above. They arrive as `ai-cancel` on
 * the channel, and the session routes them to `run.abortSignal` through the SDK's
 * built-in cancel routing.
 */

import Ably from 'ably';
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai';

import type { VercelOutput, VercelProjection, VercelRunOutcome } from '@ably/ai-transport/vercel';
import {
  approvedPendingToolCalls,
  finishRun,
  finishStep,
  pendingToolCalls,
  stripToolExecutes,
  vercelRunOutcome,
} from '@ably/ai-transport/vercel';
import { ErrorCode, type AgentRun, type RunStep } from '@ably/ai-transport';
import type { RunActivityInput } from '@ably/ai-transport/temporal';

import { createModel } from '../app/api/chat/model.js';
import { SYSTEM_PROMPT } from '../app/api/chat/prompt.js';
import { tools } from '../app/api/chat/tools.js';
import { ablyTransport } from './ably-transport.js';
import type { InferenceOutcome, ToolCallInfo } from './shared.js';

// The concrete run type the helpers below work with. The activity bodies get it
// inferred from the codec, so only these standalone helpers name it.
type VercelAgentRun = AgentRun<VercelOutput, VercelProjection, UIMessage>;

/**
 * One inference pass's result. Carries the SDK's own outcome type rather than
 * this app's, so `finishRun` and `finishStep` can route it, plus the server tools
 * to dispatch when a `suspend` turned out to be a server-tool request.
 */
interface PassResult {
  vercel: VercelRunOutcome;
  serverToolCalls?: ToolCallInfo[];
}

/**
 * Flatten a pass into the outcome the WORKFLOW reads. The workflow sees this
 * across Temporal's serialisation boundary, which is why the error becomes a
 * plain message rather than an `Ably.ErrorInfo`.
 */
function _toInferenceOutcome(pass: PassResult): InferenceOutcome {
  if (pass.serverToolCalls) return { kind: 'server-tools', serverToolCalls: pass.serverToolCalls };
  if (pass.vercel.reason === 'error') return { kind: 'error', errorMessage: pass.vercel.error.message };
  if (pass.vercel.reason === 'suspend') return { kind: 'suspend' };
  return { kind: pass.vercel.reason };
}

// -----------------------------------------------------------------------------
// runInferenceStep — ONE turn's inference, published as exactly one SDK step.
// Drives every inference in the turn, first and follow-ups alike, against the run
// the SDK's openRun (or a prior step) left active.
// Client steering (a follow-up user-message folded into the active run while we
// stream) loops another inference pass into the SAME step inside this activity,
// rather than round-tripping through the workflow. One step per activity keeps
// the retry deterministic — a retry re-runs the turn under the same stepId and
// supersedes its prior attempt's output. Server tools have their `execute`
// stripped so the AI SDK stops after the call and we drive the tool exec via
// runToolStep.
//
// `history: 'full'` because the model needs the whole conversation. The scaffold
// pages it before the body runs.
//
// Resume-visibility race: when the turn is a continuation, the SDK's openRun
// published `ai-run-resume` on its own session and detached. This activity's
// `run.load()` pages channel history to status-gate the run, and may read the
// pre-resume `ai-run-suspend` before the `ai-run-resume` has propagated into
// history — tripping load()'s suspended gate. That gate throws BEFORE the model
// is called (no wasted inference, no partial output), and Temporal retries this
// activity; by the retry the resume has folded and load() passes.
// -----------------------------------------------------------------------------

export const runInferenceStep = ablyTransport.activity(
  { history: 'full' },
  async ({ run, step }): Promise<InferenceOutcome> => {
    const pass = await _runInferenceStep(run, step);

    // Server tools are the only non-terminal outcome: the workflow runs them and
    // calls back in, so the run stays open. Everything else gets its terminal
    // published here, where the run is already loaded and it costs nothing.
    if (!pass.serverToolCalls) await finishRun(run, pass.vercel);

    const outcome = _toInferenceOutcome(pass);
    console.log('[inference] outcome', { kind: outcome.kind });
    return outcome;
  },
);

// One inference turn, published as a single SDK step.
//
// The pre-check dispatches a just-approved server tool before any model call.
// Otherwise this runs the triggering input's inference pass into the step, then
// loops another pass into the SAME step for each
// steering message a client folded into the run while we streamed: after a
// `complete` pass, `run.hasInput()` reports (and drains) the pending steering
// message, and the next pass answers it. Each pass's `step.pipe` stamps the
// steering message it drained as a consumed `steer-codec-message-ids`, so the
// client's steering outcome resolves consumed.
// Non-`complete` outcomes (server-tools / suspend / cancelled / error) end the
// loop and route the run on their own.
//
// The step comes from the scaffold, already started, under the activity's
// deterministic id — so a retry re-runs the whole turn under the same id and
// supersedes its prior attempt's output.
async function _runInferenceStep(run: VercelAgentRun, step: RunStep<VercelOutput>): Promise<PassResult> {
  // Pre-check: if this invocation was triggered by a `tool-approval-response`
  // (approved=true), the last assistant's tool part is in
  // `approval-responded` state and the framework owes it an output.
  // Dispatch it as a server-tools step now, before calling the model — the LLM
  // would otherwise see an open `tool_use` with no matching `tool_result` and
  // reject. Only match `approval-responded` here (not
  // `input-available`) so this branch doesn't race with the post-`streamText`
  // classification below, which is where a fresh call the model just emitted is
  // handled.
  //
  // The step is already open, so this turn publishes an empty one. That is the
  // honest record: this activity did no inference, and the tool that follows
  // publishes under its own step.
  const approvedServerCalls = _filterServerToolCalls(approvedPendingToolCalls(run.messages));
  if (approvedServerCalls.length > 0) {
    return { vercel: { reason: 'suspend' }, serverToolCalls: approvedServerCalls };
  }

  // Run the triggering input's pass, then loop another pass into this same step
  // for each steering message that folded in while the previous pass streamed.
  // hasInput() gates every pass — including the first, so a run cancelled before
  // any inference skips the loop entirely — and only a `complete` pass can be
  // steered; the others route the run on their own. `pass` is unset until the
  // first one runs, so the guard reads it null-safely.
  let pass: PassResult | undefined;
  while ((!pass || pass.vercel.reason === 'complete') && run.hasInput()) {
    pass = await _runInferencePass(run, step);
  }

  // If the run was already cancelled before the first pass, hasInput() was false
  // and no pass ran — treat that as a cancellation.
  const finalPass: PassResult = pass ?? { vercel: { reason: 'cancelled' } };

  // Close the step with the reason the final pass implies. A piped stream error
  // already marks it failed; the empty-conversation guard has no pipe, so this is
  // what supplies the reason there.
  await finishStep(step, finalPass.vercel);

  return finalPass;
}

// One inference pass into an already-open step: streamText + pipe, then classify
// the outcome. Server tools have their `execute` stripped so the AI SDK stops
// after the call and the workflow drives the tool via runToolStep.
async function _runInferencePass(run: VercelAgentRun, step: RunStep<VercelOutput>): Promise<PassResult> {
  const conversation = run.view.getMessages().map((m) => m.message);
  if (conversation.length === 0) {
    // Defensive: guards against a cross-activity tree hydration edge case where
    // the view's branch-source returns no messages after multiple resume cycles.
    // Treat this as a stop so the workflow ends the run cleanly instead of
    // dying inside streamText with 'messages must not be empty'.
    console.warn('[inference] conversation is empty — ending run to avoid crash');
    return {
      vercel: {
        reason: 'error',
        error: new Ably.ErrorInfo('conversation drain returned no messages', ErrorCode.StreamError, 500),
      },
    };
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
  if (outcome.reason !== 'suspend') return { vercel: outcome };

  // Suspend outcome — classify: fresh server-tool calls (have `execute` in
  // the registry) become server-tool activities; anything else (client
  // tools, approval-requested tools) suspends the run for the client to
  // resolve. `pendingToolCalls` matches `input-available` only, so a
  // just-approved call that landed during this activity's `streamText` is
  // NOT caught here — the follow-up workflow spawned by the
  // `tool-approval-response` handles it via the pre-check above.
  const serverToolCalls = _filterServerToolCalls(pendingToolCalls(run.messages));
  if (serverToolCalls.length > 0) return { vercel: outcome, serverToolCalls };

  return { vercel: outcome };
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
// tool-output-available chunk on its own SDK step. The scaffold opens that step
// under the retry-stable id and closes it when this returns, so there is nothing
// here but the tool call.
//
// On failure it throws, and the scaffold deliberately leaves the step open:
// Temporal re-runs this activity under the same stepId, and the retry supersedes
// the failed attempt's channel output. That only works because the session is
// detached rather than ended — ending would publish `ai-run-end` and every retry
// would fail with "run is terminal (read-only)". Workflow-level `cleanupRun`
// marks the run 'error' once retries are truly exhausted.
// -----------------------------------------------------------------------------

export const runToolStep = ablyTransport.activity(
  async ({ step }, input: RunActivityInput & { toolCall: ToolCallInfo }): Promise<void> => {
    const tool = (tools as Record<string, { execute?: (input: unknown) => Promise<unknown> }>)[input.toolCall.toolName];
    if (!tool?.execute) throw new Error(`tool '${input.toolCall.toolName}' has no execute`);
    const output = await tool.execute(input.toolCall.input);

    await step.send({
      type: 'tool-output-available',
      toolCallId: input.toolCall.toolCallId,
      output,
    });
  },
);
