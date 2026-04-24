/**
 * Abort and pause — serverless agent side.
 *
 * Demonstrates three things:
 *   - Handling a pre-existing abort (published while no agent was live)
 *     observed as `step.signal.aborted === true` immediately after `start()`.
 *   - Surfacing live aborts to the model SDK through `step.signal`.
 *   - Reacting to a durable pause signal via the step's `'pause'` event,
 *     converting it into a cooperative cancellation the handler owns so
 *     the serverless container can publish the correct terminal state
 *     before the request ends.
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
 * Agent HTTP handler demonstrating durable abort plus the pause event.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the step has ended.
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

  // Convert pause into a cooperative cancellation the handler owns, so the
  // stream unwinds and the terminal publish happens inside the request.
  const pauseCtrl = new AbortController();
  let paused = false;
  step.on('pause', () => {
    paused = true;
    pauseCtrl.abort();
  });

  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  // A prior abort already on the channel leaves step.signal aborted.
  if (step.signal.aborted) {
    await step.end('aborted');
    await run.end('aborted');
    return new Response(undefined, { status: 202 });
  }

  try {
    const result = await agent.stream({
      messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
      abortSignal: AbortSignal.any([step.signal, pauseCtrl.signal]),
    });
    await step.pipe(result.toUIMessageStream());

    if (paused) {
      await step.end('paused');
      await run.suspend('paused');
    } else {
      await step.end('complete');
      await run.end('complete');
    }
  } catch (err) {
    if (paused) {
      await step.end('paused');
      await run.suspend('paused');
    } else {
      await run.end(step.signal.aborted ? 'aborted' : 'failed');
    }
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
