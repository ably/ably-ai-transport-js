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
 * Each activity is fresh-process safe: it builds its own `Ably.Realtime`, gets a
 * session from `withAgentSession`, does its work, publishes its terminal
 * (`ai-run-end` / `ai-run-suspend`) inline in that same session, then closes the
 * client. Publishing the terminal here is free, because this activity already has
 * the run loaded; doing it from the workflow instead would pay a fresh adopt.
 *
 * `withAgentSession` owns the session lifecycle: connect, run the body, and
 * detach on both success and failure. Detaching rather than ending is what makes
 * a Temporal retry work — ending would mark the run terminal, and the retry would
 * have nothing to publish onto.
 *
 * Boilerplate lives in the SDK across three subpaths:
 *
 *   - `@ably/ai-transport`          — step.send (method)
 *   - `@ably/ai-transport/vercel`   — withAgentSession, stripToolExecutes, pendingToolCalls
 *   - `@ably/ai-transport/temporal` — stepIdFor, the plugin
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
  pendingToolCalls,
  stripToolExecutes,
  vercelRunOutcome,
  withAgentSession,
} from '@ably/ai-transport/vercel';
import { ErrorCode, type AgentRun, type InvocationData, type RunIdentity } from '@ably/ai-transport';
import { stepIdFor } from '@ably/ai-transport/temporal';

import { createModel } from '../app/api/chat/model.js';
import { SYSTEM_PROMPT } from '../app/api/chat/prompt.js';
import { tools } from '../app/api/chat/tools.js';
import { logger, makeAbly } from './ably.js';
import type { InferenceOutcome, ToolCallInfo } from './shared.js';

// Concrete run type this file works with — every activity uses the Vercel codec.
type VercelAgentRun = AgentRun<VercelOutput, VercelProjection, UIMessage>;
type VercelRunStep = ReturnType<VercelAgentRun['createStep']>;

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
        error: new Ably.ErrorInfo(outcome.errorMessage, ErrorCode.RunResponseStreamFailed, 500),
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
// run the SDK's openRun (or a prior step) left active, loads it, and runs the
// model.
// Client steering (a follow-up user-message folded into the active run while we
// stream) loops another inference pass into the SAME step inside this activity,
// rather than round-tripping through the workflow. One step per activity keeps
// the retry deterministic — a retry re-runs the turn under the same stepId and
// supersedes its prior attempt's output. Server tools have their `execute`
// stripped so the AI SDK stops after the call and we drive the tool exec via
// runToolStep.
//
// Resume-visibility race: when the turn is a continuation, the SDK's openRun
// published
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
  ids: RunIdentity;
  invocation: InvocationData;
}

export async function runInferenceStep(input: StepInput): Promise<InferenceOutcome> {
  const cancelSignal = Context.current().cancellationSignal;
  const ably = makeAbly();
  try {
    // This body publishes the run's terminal itself when it reaches one; the
    // session is only ever detached. Ending it would publish `ai-run-end` and
    // mark the run terminal, which would break both the hand-off to the next
    // activity and any Temporal retry of this one.
    return await withAgentSession<InferenceOutcome>(
      { client: ably, invocation: input.invocation, logger },
      async ({ session, invocation }) => {
        const run = session.adoptRun(invocation, input.ids, { signal: cancelSignal });

        await run.load();

        // Load history for the LLM conversation.
        while (run.view.hasOlder()) await run.view.loadOlder();

        const outcome = await _runInferenceStep(run, stepIdFor(input.ids.invocationId));

        await _publishRunTerminal(run, outcome);

        return outcome;
      },
    );
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

  try {
    // `tool.execute()` throws are typically retryable: Temporal re-runs this
    // activity under the same `stepId`, and the retry supersedes the failed
    // attempt's output via the SDK's step-start-serial supersede semantics. That
    // only works because the session is detached rather than ended — ending
    // would publish `ai-run-end` and every retry would fail with "run is
    // terminal (read-only)". Workflow-level `cleanupRun` marks the run 'error'
    // once retries are truly exhausted.
    await withAgentSession<void>(
      { client: ably, invocation: input.invocation, logger },
      async ({ session, invocation }) => {
        const run = session.adoptRun(invocation, input.ids, { signal: cancelSignal });
        await run.load();

        const step = run.createStep({ stepId });
        await step.start();

        const tool = (tools as Record<string, { execute?: (input: unknown) => Promise<unknown> }>)[
          input.toolCall.toolName
        ];
        if (!tool?.execute) throw new Error(`tool '${input.toolCall.toolName}' has no execute`);
        const output = await tool.execute(input.toolCall.input);

        await step.send({
          type: 'tool-output-available',
          toolCallId: input.toolCall.toolCallId,
          output,
        });
        await step.end();
      },
    );
  } finally {
    ably.close();
  }
}
