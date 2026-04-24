/**
 * Steering — serverless agent side.
 *
 * The agent loops until no new user input has arrived between iterations.
 * `run.view.messages` updates live as the client publishes steering
 * messages during a running generation, so each iteration's request
 * includes every follow-up the user has typed so far.
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
 * Agent HTTP handler that loops as long as new user messages arrive.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the agent's loop terminates.
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

  const latestUserId = (): string | undefined => run.view.messages.findLast((n) => n.message.role === 'user')?.id;
  let lastUserId = latestUserId();

  try {
    while (!step.signal.aborted) {
      const result = await agent.stream({
        messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
        abortSignal: step.signal,
      });
      await step.pipe(result.toUIMessageStream());

      const currentUserId = latestUserId();
      if (currentUserId === lastUserId) break;
      lastUserId = currentUserId;
    }

    await step.end('complete');
    await run.end('complete');
  } catch (error) {
    await run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw error;
  }

  return new Response(undefined, { status: 202 });
};
