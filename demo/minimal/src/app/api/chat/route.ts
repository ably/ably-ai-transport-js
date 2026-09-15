/**
 * The agent. The browser has already published the user's message on the
 * channel; it POSTs that message here, the route records it in the
 * conversation the store holds for the channel, and streams the model's reply
 * back over the same channel. Once the reply has landed, the route records
 * the reply and the pipe's last serial in the store.
 */

import { channelAgent, createTransport, ErrorCode } from '@ably/ai-transport';
import { vercel } from '@ably/ai-transport/vercel';
import { convertToModelMessages, streamText, toUIMessageStream, type UIMessage } from 'ai';
import Ably from 'ably';

import { loadConversation, recordMessages } from '../store';
import { createModel } from './model';

interface ChatRequest {
  channelName: string;
  /** The user's new message, already published on the channel. */
  message: UIMessage;
}

export async function POST(req: Request) {
  const { channelName, message } = (await req.json()) as ChatRequest;
  // Record the message and an empty placeholder for its reply now, under the
  // id the reply will carry. That fixes the conversation's order before the
  // reply lands: a second turn sent meanwhile goes after the placeholder,
  // and a reply cancelled part-way keeps its place, which the page fills
  // from channel history. The model gets the conversation without the
  // placeholders, since a reply still in flight has nothing to say yet.
  const replyId = crypto.randomUUID();
  recordMessages(channelName, [message, { id: replyId, role: 'assistant', parts: [] }]);
  const messages = (loadConversation(channelName)?.messages ?? [message]).filter((m) => m.parts.length > 0);
  const apiKey = process.env.ABLY_API_KEY;
  if (apiKey === undefined) {
    return new Response('ABLY_API_KEY is not set', { status: 500 });
  }

  // A client per request: the agent is short-lived, and one per reply keeps
  // concurrent replies on the same channel from closing each other's client.
  // Ably rolls the appends a connection publishes within 40ms into one
  // delivery; a window of 0 delivers every chunk as its own message.
  const ably = new Ably.Realtime({ key: apiKey, transportParams: { appendRollupWindow: 0 } });
  const channel = ably.channels.get(channelName, { params: { agent: channelAgent(vercel) } });
  const transport = createTransport({ channel, codec: vercel });

  try {
    const result = streamText({
      model: createModel(),
      messages: await convertToModelMessages(messages),
      abortSignal: req.signal,
    });
    // One Ably operation per chunk: the text streams as appends to one
    // message, and everything else is a publish. A closed browser tab aborts
    // the pipe through the request's signal, and the pipe then rejects
    // OperationCancelled once it has flushed what it wrote.
    // Each reply needs its own message id on its `start` chunk, or every
    // reply merges into the same message on the page; the AI SDK stamps one
    // only when asked.
    // `onEnd` receives the reply the AI SDK assembled from the chunks, which
    // is what the store records. The pipe reads the stream to its end before
    // it resolves, so the callback has run by the time the serial is known.
    let reply: UIMessage | undefined;
    try {
      const { serial } = await transport.pipe(
        toUIMessageStream({
          stream: result.fullStream,
          originalMessages: messages,
          generateMessageId: () => replyId,
          onEnd: ({ responseMessage }) => {
            reply = responseMessage;
          },
        }),
        { signal: req.signal },
      );
      // The reply replaces its placeholder. `serial` is undefined only when
      // the pipe published nothing, and then there is no reply to record.
      if (reply !== undefined && serial !== undefined) recordMessages(channelName, [reply], serial);
    } catch (error) {
      // A cancelled or failed pipe leaves the placeholder empty: a browser
      // that comes back fills it from what did land on the channel.
      if (error instanceof Ably.ErrorInfo && error.code === ErrorCode.OperationCancelled) {
        // The cancelled pipe published no `finish`, so tell every tab the
        // reply has ended. Best effort: a tab that misses it reads the
        // channel on its next load.
        try {
          await transport.send({ type: 'abort' });
        } catch (sendError) {
          console.error('abort publish failed', sendError);
        }
        return new Response(null, { status: 204 });
      }
      console.error('pipe failed', error);
      return new Response(error instanceof Error ? error.message : 'pipe failed', { status: 500 });
    }
    return new Response(null, { status: 204 });
  } finally {
    await transport.close();
    ably.close();
  }
}
