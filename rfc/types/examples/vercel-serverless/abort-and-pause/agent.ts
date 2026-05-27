/**
 * Abort and pause — serverless agent side.
 *
 * Demonstrates three things:
 *   - Handling a pre-existing abort (published while no agent was live)
 *     observed as `step.signal.aborted === true` immediately after `start()`.
 *   - Surfacing live aborts to the model SDK through `step.signal` —
 *     the broad signal aborts on both `x-ably-abort` and `x-ably-pause`.
 *   - Letting the run-end inference classify pause vs abort. The catch
 *     passes the error through to `step.end(error)` and `run.end(error)`;
 *     the SDK reads `step.signal.reason` to route to the correct terminal
 *     (a paused pause, an aborted abort) without the caller branching.
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
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  try {
    // A prior abort or pause already on the channel leaves step.signal
    // aborted; the model SDK observes that and rejects synchronously.
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
