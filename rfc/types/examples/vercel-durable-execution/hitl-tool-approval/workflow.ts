/**
 * HITL tool approval — durable-execution workflow.
 *
 * Same shape as the serverless variant, wrapped in `'use step'`/
 * `'use workflow'` boundaries. The first hop streams the model's response;
 * if a tool has `needsApproval: true` and the model wants to call it, AI
 * SDK v6 surfaces the call as a `tool-${name}` part in state
 * `'approval-requested'` rather than executing. The hop returns
 * `'awaiting-input'`, the workflow suspends the run, and exits. A later
 * client invocation (paired with a `tool-approval-response` event published
 * via `run.sendEvents`) starts a fresh workflow run that reads the
 * conversation — with the tool part now in `'approval-responded'` after the
 * codec's accumulator has applied the event — and continues.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, isToolUIPart, streamText } from 'ai';

import type { Codec, InvocationData, StorageReader } from '../../../index.js';
import { createAgentSession, ErrorCode, Invocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>;
declare const openai: (model: string) => AI.LanguageModel;
declare const tools: AI.ToolSet; // one or more have `needsApproval: true`
declare const workflowStateReader: (runId: string) => StorageReader;

/** Outcome of one hop. */
type HopOutcome = 'awaiting-input' | 'complete';

/** Upper bound on agent hops across all workflow runs combined. */
const MAX_STEPS = 20;

/**
 * Narrow a caught value to an {@link Ably.ErrorInfo} with the given code.
 * @param value - The value caught.
 * @param code - The error code to check for.
 * @returns Whether the value is an `Ably.ErrorInfo` with a matching `code`.
 */
const isErrorInfoWithCode = (value: unknown, code: ErrorCode): boolean =>
  value instanceof Ably.ErrorInfo && value.code === code;

/**
 * One hop of the agent. Returns `'awaiting-input'` if the final assistant
 * message has any tool part still in state `'approval-requested'`;
 * otherwise returns `'complete'` once the response has been produced.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 * @param options - WDK step context, providing the durable `abortSignal`.
 * @returns Whether the hop needs HITL input or has finished the run.
 */
export const runAgentHop = async (
  invocationData: InvocationData,
  { abortSignal: wdkSignal }: { abortSignal: AbortSignal },
): Promise<HopOutcome> => {
  'use step';

  const invocation = Invocation.fromJSON(invocationData);

  await using session = createAgentSession({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
    storageReader: workflowStateReader(invocation.runId),
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();

  try {
    await step.start({ signal: wdkSignal, timeoutMs: 60_000 });
  } catch (e) {
    if (isErrorInfoWithCode(e, ErrorCode.StepSuperseded)) return 'complete';
    throw e;
  }

  const result = streamText({
    model: openai('gpt-4o'),
    messages: await convertToModelMessages(view.messages.map((n) => n.message)),
    tools,
    abortSignal: step.signal,
  });
  await step.pipe(result.toUIMessageStream());
  await step.end('complete');

  const last = view.messages.findLast((n) => n.message.role === 'assistant');
  const pending = last?.message.parts.filter(isToolUIPart).some((part) => part.state === 'approval-requested') ?? false;
  return pending ? 'awaiting-input' : 'complete';
};

/**
 * Suspend the run as `awaiting-input`. Writer-only durable publish
 * (plan §5.7).
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 */
export const suspendAwaitingInput = async (invocationData: InvocationData): Promise<void> => {
  'use step';

  const session = createAgentSession({
    client: ably,
    sessionName: invocationData.sessionName,
    codec,
  });
  await session.writer.suspendRun({ runId: invocationData.runId, reason: 'awaiting-input' });
  await session.close();
};

/**
 * Close the run once the agent has produced the final response. Writer-
 * only durable publish (plan §5.7).
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 */
export const endRun = async (invocationData: InvocationData): Promise<void> => {
  'use step';

  const session = createAgentSession({
    client: ably,
    sessionName: invocationData.sessionName,
    codec,
  });
  await session.writer.endRun({ runId: invocationData.runId, status: 'complete' });
  await session.close();
};

/**
 * Top-level workflow. A tool-call outcome suspends the run and exits;
 * a `complete` outcome loops (or ends the run if no tool was proposed).
 * A follow-up invocation from the client starts a fresh workflow run.
 * @param invocationData - The serialized {@link InvocationData} from the starting HTTP request.
 */
export const hitlWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  for (let i = 0; i < MAX_STEPS; i++) {
    const outcome = await runAgentHop(invocationData, { abortSignal: new AbortController().signal });
    if (outcome === 'awaiting-input') {
      await suspendAwaitingInput(invocationData);
      return;
    }
    await endRun(invocationData);
    return;
  }
};
