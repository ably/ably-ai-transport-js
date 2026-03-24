/**
 * Chat API route — receives messages from the client transport's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Key difference from use-chat demo: this route reads `history` from the POST
 * body because the generic transport doesn't auto-include it like ChatTransport.
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
  if (messages.length > 0) {
    await turn.addMessages(messages, { clientId });
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
  // streamResponse picks up parent/forkOf from the turn configuration.
  after(async () => {
    const { reason } = await turn.streamResponse(result.toUIMessageStream());
    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}
