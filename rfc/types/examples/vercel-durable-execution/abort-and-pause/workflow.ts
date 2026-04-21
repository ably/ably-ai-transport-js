/**
 * Abort and pause — durable-execution workflow.
 *
 * With each hop a `"use step"` durable boundary, abort and pause are
 * naturally durable: a signal published while no hop is running lands on
 * the channel and is picked up by the next hop when it calls
 * `step.start()`. Abort closes the run terminally between hops; pause
 * suspends the run and leaves it waiting for a resume invocation.
 *
 * Within a hop, `step.signal` surfaces live aborts to the model SDK and
 * the pause event converts a pause into a cooperative cancellation the
 * hop's handler owns, so the terminal publish happens inside the hop's
 * durable boundary.
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

/** Outcome of one hop — tells the workflow whether to continue, stop, or suspend. */
type HopOutcome =
  | { kind: 'continue'; finishReason: AI.FinishReason }
  | { kind: 'aborted' }
  | { kind: 'paused' };

/** Upper bound on agent hops — guards against runaway loops. */
const MAX_STEPS = 20;

/**
 * One hop of the agent loop. Surfaces abort and pause as structured
 * outcomes so the workflow can close or suspend the run without needing
 * to replay hop bodies.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 * @returns The hop's outcome.
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

  const pauseCtrl = new AbortController();
  let paused = false;
  step.on('pause', () => {
    paused = true;
    pauseCtrl.abort();
  });

  await step.start();

  // Pre-existing abort was already on the channel.
  if (step.signal.aborted) {
    await step.end('aborted');
    return { kind: 'aborted' };
  }

  const bridge = new TransformStream<AI.UIMessageChunk, AI.UIMessageChunk>();
  const readable: ReadableStream<AI.UIMessageChunk> = bridge.readable;

  try {
    const [, result] = await Promise.all([
      step.pipe(readable),
      agent.stream({
        messages: await convertToModelMessages(view.messages.map((n) => n.message)),
        writable: bridge.writable,
        stopWhen: stepCountIs(1),
        abortSignal: AbortSignal.any([step.signal, pauseCtrl.signal]),
      }),
    ]);
    await step.end('complete');
    return { kind: 'continue', finishReason: result.steps.at(-1)?.finishReason ?? 'stop' };
  } catch {
    if (paused) {
      await step.end('paused');
      return { kind: 'paused' };
    }
    await step.end('aborted');
    return { kind: 'aborted' };
  }
};

/**
 * Close the run with the given terminal status. A short `"use step"`
 * wrapper so the publish is durable even if the workflow is interrupted
 * after the final hop.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 * @param status - Terminal status for the run.
 */
export const endRun = async (invocationData: InvocationData, status: 'complete' | 'aborted'): Promise<void> => {
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
  await view.run.end(status);
};

/**
 * Suspend the run with `paused`. Separate `"use step"` so the suspend
 * publish is durable even if the workflow process is then terminated.
 * @param invocationData - The serialized {@link InvocationData} identifying the run.
 */
export const suspendRun = async (invocationData: InvocationData): Promise<void> => {
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
  await view.run.suspend('paused');
};

/**
 * Top-level workflow. Loops over hops until the agent finishes, the run
 * is aborted, or the run is paused. A resume invocation (paired with an
 * `x-ably-resume` signal) kicks off a fresh workflow run that picks up
 * from the session state.
 * @param invocationData - The serialized {@link InvocationData} from the starting HTTP request.
 */
export const agentWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  for (let i = 0; i < MAX_STEPS; i++) {
    const outcome = await runAgentHop(invocationData);
    if (outcome.kind === 'aborted') {
      await endRun(invocationData, 'aborted');
      return;
    }
    if (outcome.kind === 'paused') {
      await suspendRun(invocationData);
      return;
    }
    if (outcome.finishReason !== 'tool-calls') {
      await endRun(invocationData, 'complete');
      return;
    }
  }
};
