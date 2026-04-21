/**
 * Basic chat — durable-execution workflow.
 *
 * A `DurableAgent` tool-calling loop expressed as a Vercel Workflow DevKit
 * workflow, with a 1:1:1 correspondence between:
 *
 *   - one LLM hop of the agent loop,
 *   - one WDK durable boundary (the `"use step"` function), and
 *   - one AIT transport step (`view.createStep()` / `step.end()`).
 *
 * Each hop is driven by `agent.stream(...)` with `stopWhen: stepCountIs(1)`
 * so the agent yields control back after one LLM call (plus the tools
 * that call produced). The outer `"use workflow"` function records the
 * loop's orchestration in WDK's event log; the per-hop `"use step"`
 * helper runs inside a durable boundary with automatic retry. The loop
 * terminates when the model's `finishReason` is anything other than
 * `'tool-calls'`.
 *
 * Pairing each agent hop with its own (WDK step, AIT step) keeps the
 * retry unit as small as possible: a failed hop re-runs only that hop,
 * and the new `x-ably-step-start` supersedes the abandoned attempt via
 * total-order arbitration on the channel.
 */

import { DurableAgent } from '@workflow/ai/agent';
import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs } from 'ai';
import { getWritable } from 'workflow';

import type { Codec, InvocationData, StorageReader } from '../../../index.js';
import { createAgentSession, createInvocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const tools: AI.ToolSet;

// App-specific helper: yields a StorageReader backed by the workflow's
// framework state for the given run, so each hop hydrates the AIT
// session without replaying the channel.
declare const workflowStateReader: (runId: string) => StorageReader;

const agent = new DurableAgent({
  model: 'openai/gpt-4o',
  tools,
});

/** Upper bound on agent hops — guards against runaway loops. */
const MAX_STEPS = 20;

/**
 * One hop of the agent loop, wrapped in a WDK step and an AIT transport
 * step. Runs exactly one LLM call via `stopWhen: stepCountIs(1)`.
 * @param invocationData - The serialized {@link InvocationData} the client posted.
 * @returns The `finishReason` from the LLM hop so the workflow can decide whether to continue.
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

  const lastStep = result.steps.at(-1);
  return lastStep?.finishReason ?? 'stop';
};

/**
 * Close the run once the agent has produced a terminal response. Owns
 * its own AIT session purely to publish `x-ably-run-end`, keeping the
 * write durable under `"use step"`.
 * @param invocationData - The serialized {@link InvocationData} identifying the run to close.
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
 * Top-level workflow. Orchestrates the loop — each iteration invokes
 * `runAgentHop` and terminates when the model's `finishReason` is
 * anything other than `'tool-calls'` or the safety bound is reached.
 * @param invocationData - The serialized {@link InvocationData} from the starting HTTP request.
 */
export const agentWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  // Persistent WDK output stream for the run. Exposed so WDK readers
  // (e.g. an API route returning `run.readable`) can follow along.
  getWritable<AI.UIMessageChunk>();

  for (let i = 0; i < MAX_STEPS; i++) {
    const finishReason = await runAgentHop(invocationData);
    if (finishReason !== 'tool-calls') {
      await endRun(invocationData);
      return;
    }
  }
};
