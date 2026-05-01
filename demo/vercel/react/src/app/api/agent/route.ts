/**
 * Basic-chat agent endpoint.
 *
 * Inspired by `rfc/types/examples/vercel-serverless/basic-chat/agent.ts`. One
 * invocation = one run = one step. The handler reads the {@link Invocation}
 * from the request body, binds an {@link AgentRun} to it, opens a step, pipes
 * the model's UI message stream through it, and ends the run.
 *
 * The {@link AgentSession} is cached and pre-warmed by `instrumentation.ts`
 * at server boot so the channel is already attached and hydrated from
 * channel history before any client publishes onto it. `session.createRun`
 * waits for the invocation's preconditions (run-start visible and, when set,
 * `messageId` visible) to be satisfied either by hydration or live delivery.
 */

import { anthropic } from '@ai-sdk/anthropic';
import { convertToModelMessages, streamText } from 'ai';

import { Invocation, type InvocationData } from '@ably/ai-transport';

import { getSession } from '../../../lib/agent-session';

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';

export async function POST(req: Request): Promise<Response> {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  const session = await getSession(invocation.sessionName);

  await using run = await session.createRun(invocation, { signal: req.signal });
  await using step = run.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

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

  return new Response(null, { status: 202 });
}
