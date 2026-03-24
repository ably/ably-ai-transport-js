/**
 * Chat API route — receives messages from the client transport's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Uses Next.js `after()` to stream the response without blocking the HTTP
 * response. See the docs for why this matters: docs/concepts/transport.md
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { UIMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { createServerTransport } from '@ably/ably-ai-transport-js/vercel';
import type { MessageWithHeaders } from '@ably/ably-ai-transport-js';

/** Shape of the POST body sent by the client transport. */
interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: MessageWithHeaders<UIMessage>[];
  history?: MessageWithHeaders<UIMessage>[];
  id: string;
  forkOf?: string;
  parent?: string | null;
}

// Server-side Ably client — uses API key directly (trusted environment).
const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const { messages, history, id, turnId, clientId, forkOf, parent } = (await req.json()) as ChatRequestBody;
  const channel = ably.channels.get(id);

  const transport = createServerTransport({ channel });
  const turn = transport.newTurn({ turnId, clientId, parent, forkOf });

  await turn.start();

  // Publish user messages (if any). Fork metadata (parent/forkOf) is
  // configured at the turn level — addMessages picks it up automatically.
  let lastUserMsgId: string | undefined;
  if (messages.length > 0) {
    const { msgIds } = await turn.addMessages(messages, { clientId });
    lastUserMsgId = msgIds.at(-1);
  }

  // Reconstruct full conversation for the LLM
  const historyMsgs = (history ?? []).map((h) => h.message);
  const newMsgs = (messages ?? []).map((m) => m.message);
  const allMessages = [...historyMsgs, ...newMsgs];

  const result = streamText({
    model: anthropic('claude-sonnet-4-20250514'),
    system: 'You are a helpful assistant.',
    messages: await convertToModelMessages(allMessages),
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
