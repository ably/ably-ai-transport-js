/**
 * Subagent fan-out — subagent workflow (durable execution).
 *
 * A standalone workflow identical in shape to basic-chat. Each invocation
 * opens the run the parent named, drives the agent loop one hop at a time
 * under `"use workflow"` / `"use step"`, and closes the run when the
 * agent reaches a terminal response. The subagent has no knowledge of
 * the parent — from its perspective it is just another run on the
 * shared session.
 */

import { DurableAgent } from '@workflow/ai/agent';
import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs } from 'ai';

import type { Codec, InvocationData, StorageReader } from '../../../index.js';
import { createAgentSession, createInvocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const tools: AI.ToolSet;
declare const workflowStateReader: (runId: string) => StorageReader;

const agent = new DurableAgent({
  model: 'openai/gpt-4o',
  tools,
});

/** Upper bound on agent hops — guards against runaway loops. */
const MAX_STEPS = 20;

/**
 * One hop of the subagent's loop.
 * @param invocationData - The serialized {@link InvocationData} identifying the child run.
 * @returns The hop's `finishReason`.
 */
export const runAgentHop = async (invocationData: InvocationData): Promise<AI.FinishReason> => {
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

  const bridge = new TransformStream<AI.UIMessageChunk, AI.UIMessageChunk>();
  const readable: ReadableStream<AI.UIMessageChunk> = bridge.readable;
  const [, result] = await Promise.all([
    step.pipe(readable),
    agent.stream({
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      writable: bridge.writable,
      stopWhen: stepCountIs(1),
      abortSignal: step.signal,
    }),
  ]);
  await step.end('complete');
  return result.steps.at(-1)?.finishReason ?? 'stop';
};

/**
 * Close the subagent's run.
 * @param invocationData - The serialized {@link InvocationData} identifying the child run.
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
 * Top-level subagent workflow.
 * @param invocationData - The serialized {@link InvocationData} from the parent's spawn call.
 */
export const subagentWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  for (let i = 0; i < MAX_STEPS; i++) {
    const finishReason = await runAgentHop(invocationData);
    if (finishReason !== 'tool-calls') {
      await endRun(invocationData);
      return;
    }
  }
};
