/**
 * Steering — durable-execution workflow.
 *
 * Each hop is a `"use step"` boundary that hydrates the session and
 * passes the latest `run.view.messages` to the model. Steering messages
 * the client publishes between hops land on the channel and are
 * materialised into the session during the next hop's hydration — the
 * workflow needs no special handling because it re-reads the conversation
 * on every hop.
 *
 * The workflow continues looping until the model finishes AND no new
 * user messages have arrived since the last hop.
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

/** Result returned by one hop. */
interface HopResult {
  /** The model's finishReason for this hop. */
  finishReason: AI.FinishReason;
  /** The most recent user-message ID visible in the session at hop start. */
  latestUserMessageId: string | undefined;
}

/** Upper bound on agent hops — guards against runaway loops. */
const MAX_STEPS = 40;

/**
 * Narrow a caught value to an {@link Ably.ErrorInfo} with the given code.
 * @param value - The value caught from a try/catch.
 * @param code - The {@link ErrorCode} to match on `.code`.
 * @returns `true` when `value` is an `Ably.ErrorInfo` whose `.code` matches.
 */
const isErrorInfoWithCode = (value: unknown, code: number): boolean =>
  value instanceof Ably.ErrorInfo && value.code === code;

/**
 * One hop. Returns the finishReason plus the latest user-message ID seen
 * at hop start so the workflow can decide whether to loop again.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 * @param options - WDK step context, providing the durable `abortSignal`.
 * @param options.abortSignal - Durable abort signal supplied by the WDK step context.
 * @returns The hop's finishReason and the latest user-message ID at hop start.
 */
export const runAgentHop = async (
  invocationData: InvocationData,
  { abortSignal: wdkSignal }: { abortSignal: AbortSignal },
): Promise<HopResult> => {
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
  } catch (error) {
    if (isErrorInfoWithCode(error, ErrorCode.StepSuperseded)) {
      return { finishReason: 'stop', latestUserMessageId: undefined };
    }
    throw error;
  }

  const latestUserMessageId = run.view.messages.findLast((n) => n.message.role === 'user')?.id;

  try {
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
    await step.end();

    return {
      finishReason: result.steps.at(-1)?.finishReason ?? 'stop',
      latestUserMessageId,
    };
  } catch (error) {
    await step.end(error);
    await run.end(error);
    if (!step.signal.aborted) throw error;
    return { finishReason: 'stop', latestUserMessageId };
  }
};

/**
 * Close the run once the agent and any pending steering input are done.
 * Writer-only hop per plan §5.7.
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
 * Top-level workflow. After each hop, checks whether the latest user
 * message ID changed — if so, the workflow loops again so the next hop
 * sees the new user input.
 * @param invocationData - The serialized {@link InvocationData} from the starting HTTP request.
 */
export const agentWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  let lastSeenUserId: string | undefined;

  for (let i = 0; i < MAX_STEPS; i++) {
    const hop = await runAgentHop(invocationData, { abortSignal: new AbortController().signal });

    if (hop.finishReason === 'tool-calls') {
      lastSeenUserId = hop.latestUserMessageId;
      continue;
    }

    // Agent is done for now. Loop again only if new user input arrived
    // during the most recent hop.
    if (hop.latestUserMessageId !== lastSeenUserId) {
      lastSeenUserId = hop.latestUserMessageId;
      continue;
    }

    await endRun(invocationData);
    return;
  }
};
