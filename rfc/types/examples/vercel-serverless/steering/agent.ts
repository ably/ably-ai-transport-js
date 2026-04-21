/**
 * Steering — serverless agent side.
 *
 * The agent loops until no new user input has arrived between iterations.
 * `view.messages` updates live as the client publishes steering messages
 * during a running generation, so each iteration's request includes every
 * follow-up the user has typed so far.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs, ToolLoopAgent } from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createAgentSession, createInvocation } from '../../../index.js';

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
 * Agent HTTP handler that loops as long as new user messages arrive.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the agent's loop terminates.
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

  const latestUserId = (): string | undefined => view.messages.findLast((n) => n.message.role === 'user')?.id;
  let lastUserId = latestUserId();

  while (!step.signal.aborted) {
    const result = await agent.stream({
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());

    const currentUserId = latestUserId();
    if (currentUserId === lastUserId) break;
    lastUserId = currentUserId;
  }

  await step.end('complete');
  await view.run.end('complete');
  return new Response(undefined, { status: 202 });
};
