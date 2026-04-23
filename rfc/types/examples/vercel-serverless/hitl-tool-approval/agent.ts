/**
 * HITL tool approval — serverless agent side.
 *
 * The agent streams the model's response. If a tool has `needsApproval: true`
 * and the model wants to call it, AI SDK v6 surfaces the call as a
 * `tool-${name}` part in state `'approval-requested'` (with an
 * `approval: { id }`) instead of executing it. The agent suspends the run
 * with `awaiting-input`; a later invocation paired with the client's
 * `approval-responded` mutation drives the next step, at which point AI SDK
 * v6 re-invokes the model (which now sees `tool-approval-response` in the
 * model-messages produced by `convertToModelMessages`) and executes the tool.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, isToolUIPart, streamText } from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createAgentSession, Invocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;
declare const tools: AI.ToolSet; // one or more have `needsApproval: true`

/**
 * Agent HTTP handler. Suspends the run when the final assistant message has
 * any tool part still in state `'approval-requested'`; otherwise closes.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the step has ended and the run has either suspended or closed.
 */
export const POST = async (req: Request): Promise<Response> => {
  const invocation = Invocation.fromJSON((await req.json()) as InvocationData);

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

    // AI SDK v6 represents a pending approval as a `tool-${name}` part whose
    // `state` is `'approval-requested'` on the final assistant message. Scan
    // that message's tool parts; if any are still awaiting a response,
    // suspend the run rather than closing it.
    const last = view.messages.findLast((n) => n.message.role === 'assistant');
    const pending =
      last?.message.parts.filter(isToolUIPart).some((part) => part.state === 'approval-requested') ?? false;

    await (pending ? view.run.suspend('awaiting-input') : view.run.end('complete'));
  } catch (err) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
