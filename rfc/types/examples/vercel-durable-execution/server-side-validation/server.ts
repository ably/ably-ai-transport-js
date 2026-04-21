/**
 * Server-side input validation — server route (durable execution).
 *
 * The route validates the user's input, publishes `x-ably-run-start` and
 * the user message via the session writer (without connect()), then
 * starts a workflow with the returned {@link InvocationData}. The
 * workflow has no knowledge of the validation — it just receives an
 * invocation and operates on the run.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createClientSession } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const passesModeration: (text: string) => boolean;
declare const getAuthenticatedUserClientId: (req: Request) => string;

/** Shape of the request body the server route expects. */
interface ValidateAndSendBody {
  /** The session name the message should be published to. */
  sessionName: string;
  /** The user's message text. */
  text: string;
}

/**
 * Server route. Validates the input, publishes the run-start plus
 * user message with the end-user's clientId attached, then kicks off
 * the workflow.
 * @param req - The incoming HTTP request.
 * @returns 400 if the input is rejected, otherwise 202 once the workflow has been triggered.
 */
export const POST = async (req: Request): Promise<Response> => {
  const { sessionName, text } = (await req.json()) as ValidateAndSendBody;
  if (!passesModeration(text)) return new Response('rejected', { status: 400 });

  const userClientId = getAuthenticatedUserClientId(req);
  const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName,
    codec,
  });

  const { runId } = await session.writer.startRun({ clientId: userClientId });
  const messageId = crypto.randomUUID();
  await session.writer.sendMessages({
    runId,
    clientId: userClientId,
    messages: {
      id: messageId,
      role: 'user',
      parts: [{ type: 'text', text }],
    },
  });

  const data: InvocationData = { sessionName, runId, messageId };
  await fetch('/api/workflow/start', { method: 'POST', body: JSON.stringify(data) });

  return new Response(undefined, { status: 202 });
};
