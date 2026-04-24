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
 * the parent spawned — listeners are attached per-child so late-spawned
 * children still receive the cascade.
 */
import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, jsonSchema, stepCountIs, tool, ToolLoopAgent } from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createAgentSession, Invocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;

/**
 * Parent agent HTTP handler. A `ToolLoopAgent` orchestrates fan-out via
 * its `spawnSubagent` tool; the outer loop is the agent's own internal
 * loop, not a hand-rolled `for`-over-subtasks.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the orchestration has terminated.
 */
export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  await using session = createAgentSession({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
  });
  await session.connect();

  await using run = session.createRun(invocation);
  await using step = run.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

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

      await fetch('/api/subagent', {
        method: 'POST',
        body: JSON.stringify(childRun.toInvocation().toJSON()),
      });

      // Per-child abort cascade: parent aborted -> abort this child run.
      // Registering per-child (rather than at handler top) means children
      // spawned after the parent was aborted still receive the cascade.
      const offCascade = (): void => void session.writer.abort({ runId });
      step.signal.addEventListener('abort', offCascade);

      const finalStatus = await childRun.when(['complete', 'failed', 'aborted']);
      step.signal.removeEventListener('abort', offCascade);

      const finalMessage = childRun.messages.findLast((n) => n.message.role === 'assistant');
      const text = finalMessage?.message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
      return { runId, status: finalStatus, text };
    },
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

  try {
    const result = await orchestrator.stream({
      messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());

    const outcome = step.signal.aborted ? 'aborted' : 'complete';
    await step.end(outcome);
    await run.end(outcome);
  } catch (error) {
    await run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw error;
  }

  return new Response(undefined, { status: 202 });
};
