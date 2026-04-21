/**
 * HITL tool approval — durable-execution workflow.
 *
 * The first workflow run streams the model's response inside a
 * `"use step"` boundary. If the model proposed a tool call, the hop ends
 * `complete`, the workflow suspends the run with `awaiting-input`, and
 * exits. A later client-driven invocation (paired with the user's
 * approval message) starts a fresh workflow run that reads the
 * conversation — now including the approval — and continues.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, streamText } from 'ai';

import type { Codec, InvocationData, StorageReader } from '../../../index.js';
import { createAgentSession, createInvocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;
declare const tools: AI.ToolSet;
declare const workflowStateReader: (runId: string) => StorageReader;

/** Outcome of one hop. */
type HopOutcome = 'awaiting-input' | 'complete';

/** Upper bound on agent hops across all workflow runs combined. */
const MAX_STEPS = 20;

/**
 * One hop of the agent. If the model proposes a tool call, returns
 * `'awaiting-input'`; otherwise returns `'complete'` once the final
 * response has been produced.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 * @returns Whether the hop needs HITL input or has finished the run.
 */
export const runAgentHop = async (invocationData: InvocationData): Promise<HopOutcome> => {
  'use step';

  const invocation = createInvocation(invocationData);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    name: invocation.sessionName,
    codec,
    storageReader: workflowStateReader(invocation.runId),
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();
  await step.start();

  const result = streamText({
    model: openai('gpt-4o'),
    messages: await convertToModelMessages(view.messages.map((n) => n.message)),
    tools,
    abortSignal: step.signal,
  });
  await step.pipe(result.toUIMessageStream());
  await step.end('complete');

  const last = view.messages.at(-1);
  const proposedTool = last?.message.parts.find((p) => p.type.startsWith('tool-'));
  return proposedTool ? 'awaiting-input' : 'complete';
};

/**
 * Suspend the run as `awaiting-input`. Durable publish keeps the
 * suspension observable to every participant.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 */
export const suspendAwaitingInput = async (invocationData: InvocationData): Promise<void> => {
  'use step';

  const invocation = createInvocation(invocationData);
  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    name: invocation.sessionName,
    codec,
    storageReader: workflowStateReader(invocation.runId),
  });
  await session.connect();
  const view = session.createView(invocation);
  await view.run.suspend('awaiting-input');
};

/**
 * Close the run once the agent has produced the final response.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 */
export const endRun = async (invocationData: InvocationData): Promise<void> => {
  'use step';

  const invocation = createInvocation(invocationData);
  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    name: invocation.sessionName,
    codec,
    storageReader: workflowStateReader(invocation.runId),
  });
  await session.connect();
  const view = session.createView(invocation);
  await view.run.end('complete');
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
    const outcome = await runAgentHop(invocationData);
    if (outcome === 'awaiting-input') {
      await suspendAwaitingInput(invocationData);
      return;
    }
    await endRun(invocationData);
    return;
  }
};
