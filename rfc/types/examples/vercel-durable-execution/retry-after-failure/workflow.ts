/**
 * Retry after failure — durable-execution workflow.
 *
 * Durable execution ships retries. WDK re-invokes a `"use step"`
 * function on failure until its retry budget is exhausted. Each
 * invocation creates a fresh AIT step — with its own `x-ably-step-id` —
 * so successive attempts supersede prior ones via total-order
 * arbitration on the channel.
 *
 * The application's job is to catch the error inside the `"use step"`
 * boundary so the AIT step ends `'failed'` (giving every participant a
 * durable record of the attempt) and to rethrow so WDK's retry kicks in.
 * When WDK exhausts the retry budget, the top-level workflow ends the
 * run `'failed'`.
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
 * One hop. If the hop throws, the AIT step is ended as `'failed'` before
 * the error propagates so there is a durable record of the failed
 * attempt on the channel; WDK then retries the `"use step"` function,
 * producing a fresh AIT step whose `x-ably-step-start` supersedes the
 * failed one.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 * @param options - WDK step context, providing the durable `abortSignal`.
 * @returns The hop's `finishReason`.
 */
export const runAgentHop = async (
  invocationData: InvocationData,
  { abortSignal: wdkSignal }: { abortSignal: AbortSignal },
): Promise<AI.FinishReason> => {
  'use step';

  const invocation = Invocation.fromJSON(invocationData);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
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
    if (isErrorInfoWithCode(e, ErrorCode.StepSuperseded)) return 'stop';
    throw e;
  }

  try {
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
  } catch (err) {
    // Mark the AIT attempt as failed so the channel carries a durable
    // record, then rethrow so WDK retries the `"use step"` function.
    await step.end('failed');
    throw err;
  }
};

/**
 * Close the run with the given terminal status. Writer-only hop per
 * plan §5.7.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 * @param status - Terminal status for the run.
 */
export const endRun = async (invocationData: InvocationData, status: 'complete' | 'failed'): Promise<void> => {
  'use step';

  const session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocationData.sessionName,
    codec,
  });
  await session.writer.endRun({ runId: invocationData.runId, status });
  await session.close();
};

/**
 * Top-level workflow. If a hop's retry budget is exhausted, WDK throws
 * past the `"use step"` boundary and the workflow catches the error to
 * close the run as `failed`.
 * @param invocationData - The serialized {@link InvocationData} from the starting HTTP request.
 */
export const resilientWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const finishReason = await runAgentHop(invocationData, { abortSignal: new AbortController().signal });
      if (finishReason !== 'tool-calls') {
        await endRun(invocationData, 'complete');
        return;
      }
    }
  } catch {
    await endRun(invocationData, 'failed');
  }
};
