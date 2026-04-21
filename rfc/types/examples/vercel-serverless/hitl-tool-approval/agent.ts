/**
 * HITL tool approval — serverless agent side.
 *
 * The agent streams the model's response. If the model proposed a tool
 * call, the run is suspended with `awaiting-input` rather than terminated,
 * and a later invocation paired with the user's approval drives the next
 * step on the same run.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, streamText } from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createAgentSession, Invocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;
declare const tools: AI.ToolSet;

/**
 * Agent HTTP handler that suspends the run on a proposed tool call.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the step has ended and the run has either suspended or closed.
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
    const result = streamText({
      model: openai('gpt-4o'),
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      tools,
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end('complete');

    // Did the model request a tool? Suspend the run until the user approves.
    const last = view.messages.findLast((n) => n.message.role === 'assistant');
    const proposedTool = last?.message.parts.find((p) => p.type.startsWith('tool-'));
    await (proposedTool ? view.run.suspend('awaiting-input') : view.run.end('complete'));
  } catch (err) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
