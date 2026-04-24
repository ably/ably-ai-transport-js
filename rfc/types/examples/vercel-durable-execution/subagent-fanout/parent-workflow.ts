/**
 * Subagent fan-out — parent workflow (durable execution).
 *
 * The parent is a `DurableAgent` whose tool set exposes a single
 * `spawnSubagent` tool. The orchestrator's agent loop is driven a hop at
 * a time under `"use workflow"` / `"use step"`; each `spawnSubagent`
 * call opens a new run on the same session, kicks off a child workflow,
 * and resolves when the child's run ends.
 *
 * Fan-out is expressed through the codec and the session — a child run
 * is just another run on the session. Any client observing the session
 * sees both the parent's streamed reasoning and every child run's output
 * side by side. If the parent is aborted, `step.signal` cascades via
 * `session.writer.abort` to every child run the parent spawned —
 * listeners are attached per-child so late-spawned children also
 * receive the cascade (plan §5.8).
 */

import { DurableAgent } from '@workflow/ai/agent';
import * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, jsonSchema, stepCountIs, tool } from 'ai';

import type { Codec, InvocationData, StorageReader } from '../../../index.js';
import { createAgentSession, ErrorCode, Invocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const workflowStateReader: (runId: string) => StorageReader;

/** Upper bound on orchestrator hops — guards against runaway loops. */
const MAX_STEPS = 40;

/** Narrow a caught value to an {@link Ably.ErrorInfo} with the given code. */
const isErrorInfoWithCode = (value: unknown, code: ErrorCode): boolean =>
  value instanceof Ably.ErrorInfo && value.code === code;

/**
 * One hop of the orchestrator. The tool set includes a `spawnSubagent`
 * tool that opens a child run on this session and invokes a child
 * workflow to run it.
 * @param invocationData - The serialized {@link InvocationData} identifying the orchestrator run.
 * @param options - WDK step context, providing the durable `abortSignal`.
 * @returns The hop's `finishReason`.
 */
export const runOrchestratorHop = async (
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

  const spawnSubagent = tool({
    description: 'Delegate a subtask to a fresh subagent. Returns the subagent’s final text once the run completes.',
    inputSchema: jsonSchema<{ task: string }>({
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Self-contained description of the subtask for the subagent to perform.',
        },
      },
      required: ['task'],
    }),
    execute: async ({ task }) => {
      const { runId } = await session.writer.startRun({});
      await session.writer.sendMessages({
        runId,
        messages: {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: task }],
        },
      });

      const childRun = session.tree.getRun(runId);
      if (!childRun) throw new Error('unreachable');

      await fetch('/api/subagent-workflow/start', {
        method: 'POST',
        body: JSON.stringify(childRun.toInvocation().toJSON()),
      });

      const offCascade = (): void => void session.writer.abort({ runId });
      step.signal.addEventListener('abort', offCascade);

      const finalStatus = await childRun.when(['complete', 'failed', 'aborted']);
      step.signal.removeEventListener('abort', offCascade);

      const finalMessage = childRun.messages.findLast((n) => n.message.role === 'assistant');
      const text = finalMessage?.message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
      return { runId, status: finalStatus, text };
    },
  });

  const orchestrator = new DurableAgent({
    model: 'openai/gpt-4o',
    tools: { spawnSubagent },
  });

  const bridge = new TransformStream<AI.UIMessageChunk, AI.UIMessageChunk>();
  const readable: ReadableStream<AI.UIMessageChunk> = bridge.readable;
  const [, result] = await Promise.all([
    step.pipe(readable),
    orchestrator.stream({
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
 * Close the parent run once the orchestrator has synthesised the final
 * answer. Writer-only hop per plan §5.7.
 * @param invocationData - The serialized {@link InvocationData} identifying the parent run.
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
 * Top-level parent workflow. The orchestrator's own agent loop handles
 * subtask decomposition; the workflow just advances one hop at a time
 * until the model stops calling tools.
 * @param invocationData - The serialized {@link InvocationData} from the starting HTTP request.
 */
export const parentWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  for (let i = 0; i < MAX_STEPS; i++) {
    const finishReason = await runOrchestratorHop(invocationData, { abortSignal: new AbortController().signal });
    if (finishReason !== 'tool-calls') {
      await endRun(invocationData);
      return;
    }
  }
};
