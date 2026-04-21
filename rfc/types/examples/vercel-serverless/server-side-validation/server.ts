/**
 * Server-side input validation — server route.
 *
 * The route validates the user's input, then uses a `ClientSession`'s
 * writer (without calling `connect()`) to publish `x-ably-run-start` and
 * the user message on the end-user's behalf. The returned
 * {@link InvocationData} tells the client how to invoke the agent.
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
 * Server route. Validates the input and publishes the run-start plus
 * user message with the end-user's clientId attached.
 * @param req - The incoming HTTP request.
 * @returns 400 if the input is rejected, otherwise 200 with the invocation payload.
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
  // Note: no connect() — writer publishes directly to the channel.

  // Pass clientId so x-ably-client-id attributes both publishes to the
  // end-user rather than to this backend connection. The caller owns the
  // message ID so the invocation can reference it without reading anything
  // back from the writer.
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
  return Response.json(data);
};
