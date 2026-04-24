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
import * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs } from 'ai';

import type { Codec, InvocationData, StorageReader } from '../../../index.js';
import { createAgentSession, ErrorCode, Invocation } from '../../../index.js';

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

/** Narrow a caught value to an {@link Ably.ErrorInfo} with the given code. */
const isErrorInfoWithCode = (value: unknown, code: ErrorCode): boolean =>
  value instanceof Ably.ErrorInfo && value.code === code;

/**
 * One hop of the subagent's loop.
 * @param invocationData - The serialized {@link InvocationData} identifying the child run.
 * @param options - WDK step context, providing the durable `abortSignal`.
 * @returns The hop's `finishReason`.
 */
export const runAgentHop = async (
  invocationData: InvocationData,
  { abortSignal: wdkSignal }: { abortSignal: AbortSignal },
): Promise<AI.FinishReason> => {
  'use step';

  const invocation = Invocation.fromJSON(invocationData);

  await using session = createAgentSession({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
    storageReader: workflowStateReader(invocation.runId),
  });
  await session.connect();

  await using run = session.createRun(invocation);
  await using step = run.createStep();

  try {
    await step.start({ signal: wdkSignal, timeoutMs: 60_000 });
  } catch (e) {
    if (isErrorInfoWithCode(e, ErrorCode.StepSuperseded)) return 'stop';
    throw e;
  }

  const bridge = new TransformStream<AI.UIMessageChunk, AI.UIMessageChunk>();
  const readable: ReadableStream<AI.UIMessageChunk> = bridge.readable;
  const [, result] = await Promise.all([
    step.pipe(readable),
    agent.stream({
      messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
      writable: bridge.writable,
      stopWhen: stepCountIs(1),
      abortSignal: step.signal,
    }),
  ]);
  await step.end('complete');
  return result.steps.at(-1)?.finishReason ?? 'stop';
};

/**
 * Close the subagent's run. Writer-only hop per plan §5.7.
 * @param invocationData - The serialized {@link InvocationData} identifying the child run.
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
 * Top-level subagent workflow.
 * @param invocationData - The serialized {@link InvocationData} from the parent's spawn call.
 */
export const subagentWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  for (let i = 0; i < MAX_STEPS; i++) {
    const finishReason = await runAgentHop(invocationData, { abortSignal: new AbortController().signal });
    if (finishReason !== 'tool-calls') {
      await endRun(invocationData);
      return;
    }
  }
};
