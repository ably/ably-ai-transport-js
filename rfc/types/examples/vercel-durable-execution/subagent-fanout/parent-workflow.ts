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
 * `session.writer.abort` to every child run the parent spawned.
 */

import { DurableAgent } from '@workflow/ai/agent';
import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, jsonSchema, stepCountIs, tool } from 'ai';

import type { AgentRun, AgentSession, Codec, InvocationData, StorageReader } from '../../../index.js';
import { createAgentSession, createInvocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const workflowStateReader: (runId: string) => StorageReader;

/** Upper bound on orchestrator hops — guards against runaway loops. */
const MAX_STEPS = 40;

/**
 * Resolve when the given child run reaches a terminal status.
 * @param session - The agent session whose tree is observed.
 * @param runId - The child run to wait for.
 * @returns The child run once it has ended.
 */
const waitForRunEnd = async (
  session: AgentSession<AI.UIMessageChunk, AI.UIMessage>,
  runId: string,
): Promise<AgentRun<AI.UIMessage>> =>
  new Promise<AgentRun<AI.UIMessage>>((resolve) => {
    const onRunEnded = (run: AgentRun<AI.UIMessage>): void => {
      if (run.id !== runId) return;
      session.tree.off('run-ended', onRunEnded);
      resolve(run);
    };
    session.tree.on('run-ended', onRunEnded);
  });

/**
 * One hop of the orchestrator. The tool set includes a `spawnSubagent`
 * tool that opens a child run on this session and invokes a child
 * workflow to run it.
 * @param invocationData - The serialized {@link InvocationData} identifying the orchestrator run.
 * @returns The hop's `finishReason`.
 */
export const runOrchestratorHop = async (invocationData: InvocationData): Promise<AI.FinishReason> => {
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

  const spawnedChildRunIds: string[] = [];

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
      spawnedChildRunIds.push(runId);

      await fetch('/api/subagent-workflow/start', {
        method: 'POST',
        body: JSON.stringify({ sessionName: session.name, runId }),
      });

      const child = await waitForRunEnd(session, runId);
      const finalMessage = child.messages.at(-1)?.message;
      const text = finalMessage?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
      return { runId, status: child.status, text };
    },
  });

  step.signal.addEventListener('abort', () => {
    for (const runId of spawnedChildRunIds) void session.writer.abort({ runId });
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
 * Close the parent run once the orchestrator has synthesised the final answer.
 * @param invocationData - The serialized {@link InvocationData} identifying the parent run.
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
 * Top-level parent workflow. The orchestrator's own agent loop handles
 * subtask decomposition; the workflow just advances one hop at a time
 * until the model stops calling tools.
 * @param invocationData - The serialized {@link InvocationData} from the starting HTTP request.
 */
export const parentWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  for (let i = 0; i < MAX_STEPS; i++) {
    const finishReason = await runOrchestratorHop(invocationData);
    if (finishReason !== 'tool-calls') {
      await endRun(invocationData);
      return;
    }
  }
};
