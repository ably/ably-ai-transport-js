/**
 * Basic chat — durable-execution workflow.
 *
 * A `DurableAgent` tool-calling loop expressed as a Vercel Workflow DevKit
 * workflow, with a 1:1:1 correspondence between:
 *
 *   - one LLM hop of the agent loop,
 *   - one WDK durable boundary (the `"use step"` function), and
 *   - one AIT transport step (`run.createStep()` / `step.end()`).
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
import * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs } from 'ai';
import { getWritable } from 'workflow';

import type { Codec, InvocationData, StorageReader } from '../../../index.js';
import { createAgentSession, ErrorCode, Invocation } from '../../../index.js';

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
 * Narrow an unknown caught value to an {@link Ably.ErrorInfo} with the
 * given code. Stands in for a future shared helper; inlined here so
 * examples remain self-contained without new source modules.
 */
const isErrorInfoWithCode = (value: unknown, code: ErrorCode): boolean =>
  value instanceof Ably.ErrorInfo && value.code === code;

/**
 * One hop of the agent loop, wrapped in a WDK step and an AIT transport
 * step. Runs exactly one LLM call via `stopWhen: stepCountIs(1)`.
 * @param invocationData - The serialized {@link InvocationData} the client posted.
 * @param options - WDK step context, providing the durable `abortSignal`.
 * @returns The `finishReason` from the LLM hop so the workflow can decide whether to continue.
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

    await step.end('complete');

    const lastStep = result.steps.at(-1);
    return lastStep?.finishReason ?? 'stop';
  } catch (err) {
    await run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }
};

/**
 * Close the run once the agent has produced a terminal response. Runs as
 * a writer-only hop: no `connect()`, no tree hydration — the writer
 * publishes `x-ably-run-end` directly (plan §5.7).
 * @param invocationData - The serialized {@link InvocationData} identifying the run to close.
 */
export const endRun = async (invocationData: InvocationData): Promise<void> => {
  'use step';

  const session = createAgentSession({
    client: ably,
    sessionName: invocationData.sessionName,
    codec,
  });
  // No connect() — writer publishes directly to the channel.
  await session.writer.endRun({ runId: invocationData.runId, status: 'complete' });
  await session.close();
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
    const finishReason = await runAgentHop(invocationData, { abortSignal: new AbortController().signal });
    if (finishReason !== 'tool-calls') {
      await endRun(invocationData);
      return;
    }
  }
};
