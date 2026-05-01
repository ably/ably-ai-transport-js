/**
 * Temporal activities. Activities run in regular Node.js context (unlike
 * workflows) so they can hold open connections — here we reuse a cached
 * {@link AgentSession} for each Ably session name and drive the streaming
 * exchange end-to-end.
 *
 * `runAgentTurn` mirrors the Vercel demo's `/api/agent` handler body:
 * bind a run to the invocation, open a step, pipe the model's UI message
 * stream through it, and end the run.
 */

import { Context } from '@temporalio/activity';
import { anthropic } from '@ai-sdk/anthropic';
import { convertToModelMessages, streamText } from 'ai';

import { Invocation, type InvocationData } from '@ably/ai-transport';

import { getSession } from '../lib/agent-session';

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';

export async function runAgentTurn(data: InvocationData): Promise<void> {
  const invocation = Invocation.fromJSON(data);
  const session = await getSession(invocation.sessionName);
  const signal = Context.current().cancellationSignal;

  await using run = await session.createRun(invocation, { signal });
  await using step = run.createStep();
  await step.start({ signal, timeoutMs: 60_000 });

  try {
    const messages = await convertToModelMessages(run.view.messages.map((node) => node.message));
    const result = streamText({
      model: anthropic(MODEL),
      messages,
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end();
    await run.end();
  } catch (error) {
    await step.end(error);
    await run.end(error);
    if (!step.signal.aborted) throw error;
  }
}
