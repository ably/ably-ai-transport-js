/**
 * Regenerate — serverless agent side.
 *
 * Regenerate is a client-side concern: the client forks the tree, which
 * sets a parent on the new run. The agent code is identical to basic-chat
 * — `view.messages` already reflects the correct branch because the
 * invocation pins the run.
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
 * Agent HTTP handler. Unchanged from basic-chat.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the run has closed.
 */
export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  try {
    const result = await agent.stream({
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end('complete');
    await view.run.end('complete');
  } catch (err) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
