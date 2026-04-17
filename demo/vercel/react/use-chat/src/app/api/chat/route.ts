/**
 * Chat API route — receives messages from the client transport's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Uses Next.js `after()` to stream the response without blocking the HTTP
 * response. See the docs for why this matters: docs/concepts/transport.md
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { applyToolEventsToHistory, createServerTransport } from '@ably/ai-transport/vercel';
import type { EventsNode, MessageNode } from '@ably/ai-transport';
import { tools } from './tools';

/** Shape of the POST body sent by the client transport. */
interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: MessageNode<UIMessage>[];
  history?: MessageNode<UIMessage>[];
  events?: EventsNode<UIMessageChunk>[];
  chatId: string;
  forkOf?: string;
  parent?: string;
}

// Server-side Ably client — uses API key directly (trusted environment).
const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const { messages, history, events, chatId, turnId, clientId, forkOf, parent } = (await req.json()) as ChatRequestBody;
  const channel = ably.channels.get(chatId);

  const transport = createServerTransport({ channel });
  const turn = transport.newTurn({ turnId, clientId, parent, forkOf, signal: req.signal });

  await turn.start();

  // Apply any client-shipped events (e.g. tool outputs from addToolResult)
  // to the channel BEFORE streaming the follow-up. This publishes them as
  // message.update amendments so observers and the transport tree see the
  // tool result.
  if (events && events.length > 0) {
    await turn.addEvents(events);
  }

  // Publish user messages (if any). Fork metadata (parent/forkOf) is
  // configured at the turn level — addMessages picks it up automatically.
  let lastUserMsgId: string | undefined;
  if (messages.length > 0) {
    const { msgIds } = await turn.addMessages(messages, { clientId });
    lastUserMsgId = msgIds.at(-1);
  }

  // Reconstruct full conversation for the LLM. Merge tool-result events into
  // history so convertToModelMessages sees the tool results this turn (the
  // client ships them separately to keep history nodes intact).
  const mergedHistory = applyToolEventsToHistory(events ?? [], history ?? []);
  const historyMsgs = mergedHistory.map((h) => h.message);
  const newMsgs = (messages ?? []).map((m) => m.message);
  const allMessages = [...historyMsgs, ...newMsgs];

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location.`,
    messages: await convertToModelMessages(allMessages),
    tools,
    abortSignal: turn.abortSignal,
  });

  // Stream the response over Ably in the background using after().
  // Pass parent explicitly — the assistant response is a child of the last user message.
  after(async () => {
    const { reason } = await turn.streamResponse(result.toUIMessageStream(), {
      parent: lastUserMsgId,
    });
    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}
