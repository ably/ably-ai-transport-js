/**
 * The agent. The browser has already published the user's message on the
 * channel; it POSTs the conversation so far here, and this route streams the
 * model's reply back over the same channel.
 */

import { channelAgent, createTransport, ErrorCode } from '@ably/ai-transport';
import { vercel } from '@ably/ai-transport/vercel';
import { convertToModelMessages, streamText, toUIMessageStream, type UIMessage } from 'ai';
import Ably from 'ably';

import { createModel } from './model';

interface ChatRequest {
  channelName: string;
  messages: UIMessage[];
}

export async function POST(req: Request) {
  const { channelName, messages } = (await req.json()) as ChatRequest;
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
    // reply folds into the same message on the page; the AI SDK stamps one
    // only when asked.
    try {
      await transport.pipe(
        toUIMessageStream({ stream: result.fullStream, generateMessageId: () => crypto.randomUUID() }),
        { signal: req.signal },
      );
    } catch (error) {
      if (error instanceof Ably.ErrorInfo && error.code === ErrorCode.OperationCancelled) {
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
