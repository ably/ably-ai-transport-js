/**
 * Retry after failure — serverless agent side.
 *
 * On any error during the step, the canonical catch ends the step and run
 * with the error so a subsequent `x-ably-retry` signal has something to
 * target. The retry transitions the failed run back to `active` via a
 * fresh `x-ably-step-start`.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs, ToolLoopAgent } from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createAgentSession, Invocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;
declare const tools: AI.ToolSet;

const agent = new ToolLoopAgent({
  model: openai('gpt-4o'),
  tools,
  stopWhen: stepCountIs(20),
});

/**
 * Agent HTTP handler that marks failed attempts explicitly so retry has
 * something to target.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the step has terminated.
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

  try {
    await step.start({ signal: req.signal, timeoutMs: 60_000 });
    const result = await agent.stream({
      messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
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

  return new Response(undefined, { status: 202 });
};
