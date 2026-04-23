/**
 * Subagent fan-out — subagent endpoint.
 *
 * The subagent is a `ToolLoopAgent` with its own tool set. Each invocation
 * opens the run the parent named, runs the full agent loop (model → tool
 * → model → …) inline, and closes the run when the agent reaches a
 * terminal response. The subagent has no knowledge of the parent — from
 * its perspective it is just another run on the shared session.
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
 * Subagent HTTP handler. Opens its assigned run, runs the agent loop,
 * streams the result through the AIT step, closes.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the run has terminated.
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

  const view = session.createView(invocation);
  await using step = view.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  try {
    const result = await agent.stream({
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());

    const outcome = step.signal.aborted ? 'aborted' : 'complete';
    await step.end(outcome);
    await view.run.end(outcome);
  } catch (err) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
