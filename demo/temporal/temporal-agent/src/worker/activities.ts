/**
 * The APPLICATION's Temporal activities: driving each inference
 * (`runInferenceStep`) and running a single server tool (`runToolStep`). This
 * is the half of a durable agent the SDK cannot own — the model, the system
 * prompt, the tool registry, and the loop policy are all decisions this app
 * makes.
 *
 * The run's FRAMING — opening it, and closing it when a turn fails — comes from
 * the SDK's Temporal plugin, registered in `index.ts`. Those activities carry no
 * application logic, so there is nothing here to write.
 *
 * Each activity is fresh-process safe: it builds its own `Ably.Realtime`,
 * resolves the conversation's channel, creates an agent transport on it, and
 * re-enters the open run with `adoptRun` — attach without publishing, so
 * nothing reaches the wire until the activity publishes output or a terminal.
 * The activity that reaches a terminal outcome publishes it (`ai-run-end`)
 * inline before returning; closing the
 * transport publishes nothing, so a run left active stays open on the wire for
 * the next activity to re-enter.
 *
 * Every step uses `stepIdFor` (from `@ably/ai-transport/temporal`), which is
 * stable across Temporal retries of the same activity — so a fresh-process
 * retry's output SUPERSEDES the dead attempt's channel output instead of
 * appending beside it.
 *
 * Cancels arrive as `ai-cancel` on the channel; each activity's own transport
 * routes them to `run.abortSignal` via the SDK's built-in cancel routing, so no
 * separate listener activity is needed.
 */

import { Context } from '@temporalio/activity';
import Ably from 'ably';
import { convertToModelMessages, readUIMessageStream, stepCountIs, streamText, toUIMessageStream } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';

import {
  channelAgent,
  ErrorCode,
  type AgentRunTransport,
  type AgentTransport,
  type InvocationData,
  type RunIdentity,
} from '@ably/ai-transport';
import {
  approvedPendingToolCalls,
  createAgentTransport,
  pendingToolCalls,
  stripToolExecutes,
  vercelRunOutcome,
  type VercelInput,
  type VercelOutput,
} from '@ably/ai-transport/vercel';
import { stepIdFor } from '@ably/ai-transport/temporal';

import { createModel } from '../app/api/chat/model.js';
import { SYSTEM_PROMPT } from '../app/api/chat/prompt.js';
import { tools } from '../app/api/chat/tools.js';
import { foldMessages } from '../lib/fold-messages.js';
import { logger, makeAbly } from './ably.js';
import type { InferenceOutcome, ToolCallInfo } from './shared.js';

// Concrete transport types this file works with — every activity uses the
// Vercel codec at its default instantiation.
type Transport = AgentTransport<VercelInput, VercelOutput>;
type Run = AgentRunTransport<VercelOutput>;

/**
 * Run `body` against a connected agent transport on its own Ably client,
 * closing the transport and the client afterwards. Closing publishes no
 * terminal — the hand-off discipline a durable activity needs.
 */
async function withAgentTransport<T>(
  invocation: InvocationData,
  body: (transport: Transport) => Promise<T>,
): Promise<T> {
  const ably = makeAbly();
  try {
    const channel = ably.channels.get(invocation.sessionName, { params: { agent: channelAgent() } });
    const transport = createAgentTransport({ channel, logger });
    await transport.connect();
    try {
      return await body(transport);
    } finally {
      transport.close();
    }
  } finally {
    ably.close();
  }
}

/**
 * Page the channel's history to exhaustion and fold it into the conversation.
 * History is bounded at the attach point, which is enough: the trigger — and
 * every earlier step's output — was published before this activity attached.
 */
async function loadConversation(transport: Transport): Promise<UIMessage[]> {
  let events: Parameters<typeof foldMessages>[0] = [];
  let exhausted = false;
  while (!exhausted) {
    const batch = await transport.history();
    events = [...batch.events, ...events];
    exhausted = batch.exhausted;
  }
  return foldMessages(events);
}

async function publishRunTerminal(run: Run, outcome: InferenceOutcome): Promise<void> {
  switch (outcome.kind) {
    case 'awaiting-client':
      // The client owes a tool result or an approval. Nothing resumes this
      // run, so end it complete and let the resolution wake a new one.
      await run.end({ reason: 'complete' });
      return;
    case 'server-tools':
      // The only non-terminal outcome — nothing to publish; the workflow loops
      // with a follow-up inference after its tool steps.
      return;
    case 'error':
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
// Drives every inference in the turn, first and follow-ups alike: it re-enters
// the run the SDK's openRun (or a prior step) left active, assembles the model
// context from channel history, and runs the model.
//
// One step per activity keeps the retry deterministic — a retry re-runs the
// turn under the same stepId and supersedes its prior attempt's output. Server
// tools have their `execute` stripped so the AI SDK stops after the call and
// the workflow drives the tool exec via runToolStep.
// -----------------------------------------------------------------------------

interface StepInput {
  ids: RunIdentity;
  invocation: InvocationData;
}

export async function runInferenceStep(input: StepInput): Promise<InferenceOutcome> {
  const cancelSignal = Context.current().cancellationSignal;
  return withAgentTransport(input.invocation, async (transport) => {
    // Attach-without-publishing: the handle registers for cancel routing, and
    // nothing reaches the wire until this activity publishes output or a
    // terminal. The run's opening event was already published by the plugin's
    // openRun activity.
    const run = transport.adoptRun(input.ids.runId, { invocationId: input.ids.invocationId }, { signal: cancelSignal });

    const conversation = await loadConversation(transport);

    const outcome = await runOneInference(run, conversation, stepIdFor(input.ids.invocationId));

    await publishRunTerminal(run, outcome);

    console.log('[inference] outcome', { runId: run.runId, kind: outcome.kind });
    return outcome;
  });
}

// One inference pass, published as a single SDK step. The stepId is the
// activity's stable id, so a retry re-runs the turn under the same id and
// supersedes its prior attempt's output.
async function runOneInference(run: Run, conversation: UIMessage[], stepId: string): Promise<InferenceOutcome> {
  // Pre-check: if this invocation was triggered by a `tool-approval-response`
  // (approved=true), the last assistant's tool part is in
  // `approval-responded` state and the framework owes it an output.
  // Dispatch it as a server-tools step now, before opening a step or calling
  // the model — the LLM would otherwise see an open `tool_use` with no matching
  // `tool_result` and reject. Only match `approval-responded` here (not
  // `input-available`) so this branch doesn't race with the post-`streamText`
  // classification below, which is where a fresh call the model just emitted is
  // handled.
  const approvedServerCalls = filterServerToolCalls(approvedPendingToolCalls(conversation));
  if (approvedServerCalls.length > 0) {
    return { kind: 'server-tools', serverToolCalls: approvedServerCalls };
  }

  // hasInput() gates the pass: it reports false once the run's abort signal
  // has fired, so a run cancelled before any inference skips the model call.
  if (!run.hasInput()) return { kind: 'cancelled' };

  if (conversation.length === 0) {
    // Never hand streamText an empty prompt ("messages must not be empty").
    return { kind: 'error', errorMessage: 'conversation fold returned no messages' };
  }

  const step = run.createStep({ stepId });

  const result = streamText({
    model: createModel(),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(conversation),
    tools: stripToolExecutes(tools),
    abortSignal: run.abortSignal,
    // The workflow drives multi-step: this call must not loop.
    stopWhen: stepCountIs(1),
  });

  // Tee the chunk stream: one branch goes to the wire through the step, the
  // other folds locally so pending tool calls can be classified without
  // waiting for the wire echo.
  const [wireStream, foldStream] = toUIMessageStream({ stream: result.fullStream }).tee();
  const pipeResult = await step.pipe(wireStream);
  const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
  await step.end(
    outcome.reason === 'error' ? { reason: 'failed' } : outcome.reason === 'cancelled' ? { reason: 'cancelled' } : {},
  );

  if (outcome.reason !== 'suspend') {
    // The fold branch is not needed on a terminal outcome; release its buffer.
    void foldStream.cancel();
    if (outcome.reason === 'error') return { kind: 'error', errorMessage: outcome.error.message };
    return { kind: outcome.reason };
  }

  // Stopped on tool calls — classify from the streamed assistant message:
  // fresh server-tool calls (have `execute` in the registry) become
  // server-tool activities; anything else (client tools, approval-requested
  // tools) leaves the turn for the client. `pendingToolCalls` matches
  // `input-available` only, so a just-approved call is NOT caught here — the
  // follow-up workflow spawned by the `tool-approval-response` handles it via
  // the pre-check above.
  const assistant = await lastFoldedMessage(foldStream);
  const serverToolCalls = filterServerToolCalls(pendingToolCalls(assistant ? [assistant] : []));
  if (serverToolCalls.length > 0) {
    return { kind: 'server-tools', serverToolCalls };
  }

  return { kind: 'awaiting-client' };
}

/** Fold a chunk stream through the AI SDK reducer and return the final message. */
async function lastFoldedMessage(stream: ReadableStream<UIMessageChunk>): Promise<UIMessage | undefined> {
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last;
}

// Narrow the SDK's `PendingToolCall[]` down to the ones whose `execute` lives
// in the server registry, in the shape the workflow needs to dispatch a
// `runToolStep`.
function filterServerToolCalls(
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

  // `tool.execute()` throws are typically retryable: Temporal re-runs this
  // activity under the same `stepId`, and the retry supersedes the failed
  // attempt's output via the SDK's step-start-serial supersede semantics. That
  // only works because the run is re-entered with `adoptRun` and never
  // ended here — ending would publish `ai-run-end` and every retry would find
  // the run terminal. Workflow-level `cleanupRun` marks the run 'error' once
  // retries are truly exhausted.
  await withAgentTransport(input.invocation, async (transport) => {
    const run = transport.adoptRun(input.ids.runId, { invocationId: input.ids.invocationId }, { signal: cancelSignal });

    const step = run.createStep({ stepId });

    const tool = (tools as Record<string, { execute?: (input: unknown) => Promise<unknown> }>)[input.toolCall.toolName];
    if (!tool?.execute) throw new Error(`tool '${input.toolCall.toolName}' has no execute`);
    const output = await tool.execute(input.toolCall.input);

    await step.send({
      type: 'tool-output-available',
      toolCallId: input.toolCall.toolCallId,
      output,
    });
    await step.end({});
  });
}
