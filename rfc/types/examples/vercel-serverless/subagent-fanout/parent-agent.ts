/**
 * Subagent fan-out — parent agent.
 *
 * The parent is a `ToolLoopAgent` whose tool set exposes a single
 * `spawnSubagent` tool. The model decides — based on the user's input —
 * how many subtasks to delegate, what each one should be, and when to
 * synthesise their results into a final answer. Each `spawnSubagent`
 * call opens a new run on the same session, POSTs the subagent its
 * invocation, and resolves once the child run has terminated.
 *
 * Fan-out is expressed through the codec and the session, not through a
 * bespoke orchestration protocol. The parent's tool call becomes a child
 * run; the child run is just another run on the same session. Any client
 * observing the session sees both the parent's streamed reasoning and
 * every child run's output side by side. If the parent is aborted,
 * `step.signal` cascades via `session.writer.abort` to every child run
 * the parent spawned.
 */
import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, jsonSchema, stepCountIs, tool, ToolLoopAgent } from 'ai';

import type { AgentRun, AgentSession, Codec, InvocationData } from '../../../index.js';
import { createAgentSession, createInvocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;

/**
 * Resolve when the given child run reaches a terminal status, yielding
 * the run object so the caller can read its final messages.
 * @param session - The agent session whose tree is observed.
 * @param runId - The child run to wait for.
 * @returns The child run once it has ended (complete, aborted, or failed).
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
 * Parent agent HTTP handler. A `ToolLoopAgent` orchestrates fan-out via
 * its `spawnSubagent` tool; the outer loop is the agent's own internal
 * loop, not a hand-rolled `for`-over-subtasks.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the orchestration has terminated.
 */
export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = createInvocation(data);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    name: invocation.sessionName,
    codec,
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

      await fetch('/api/subagent', {
        method: 'POST',
        body: JSON.stringify({ sessionName: session.name, runId }),
      });

      const child = await waitForRunEnd(session, runId);
      const finalMessage = child.messages.at(-1)?.message;
      const text = finalMessage?.parts.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
      return { runId, status: child.status, text };
    },
  });

  // Cascade abort: parent aborted -> publish abort for every child run.
  step.signal.addEventListener('abort', () => {
    for (const runId of spawnedChildRunIds) void session.writer.abort({ runId });
  });

  const orchestrator = new ToolLoopAgent({
    model: openai('gpt-4o'),
    tools: { spawnSubagent },
    instructions:
      'You are an orchestrator. Decompose complex requests into independent subtasks ' +
      'and delegate each one via spawnSubagent. When every subtask has returned, ' +
      'synthesise the results into a single answer for the user.',
    stopWhen: stepCountIs(20),
  });

  const result = await orchestrator.stream({
    messages: await convertToModelMessages(view.messages.map((n) => n.message)),
    abortSignal: step.signal,
  });
  await step.pipe(result.toUIMessageStream());

  const outcome = step.signal.aborted ? 'aborted' : 'complete';
  await step.end(outcome);
  await view.run.end(outcome);
  return new Response(undefined, { status: 202 });
};
