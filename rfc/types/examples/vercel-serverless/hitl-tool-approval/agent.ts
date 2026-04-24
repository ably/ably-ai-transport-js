/**
 * HITL tool approval — serverless agent side.
 *
 * The agent streams the model's response. If a tool has `needsApproval: true`
 * and the model wants to call it, AI SDK v6 surfaces the call as a
 * `tool-${name}` part in state `'approval-requested'` (with an
 * `approval: { id }`) instead of executing it. The agent suspends the run
 * with `awaiting-input`; a later invocation paired with the client's
 * `tool-approval-response` event drives the next step. The Vercel codec's
 * accumulator has already transitioned the tool part to
 * `'approval-responded'` by the time `convertToModelMessages` runs, so
 * `streamText` sees the `tool-approval-response` in the model-messages it
 * consumes and executes the tool.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, isToolUIPart, streamText } from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createAgentSession, Invocation } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>;
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
    const result = streamText({
      model: openai('gpt-4o'),
      messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
      tools,
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end('complete');

    // AI SDK v6 represents a pending approval as a `tool-${name}` part whose
    // `state` is `'approval-requested'` on the final assistant message. Scan
    // that message's tool parts; if any are still awaiting a response,
    // suspend the run rather than closing it.
    const last = run.view.messages.findLast((n) => n.message.role === 'assistant');
    const pending =
      last?.message.parts.filter(isToolUIPart).some((part) => part.state === 'approval-requested') ?? false;

    await (pending ? run.suspend('awaiting-input') : run.end('complete'));
  } catch (err) {
    await run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
