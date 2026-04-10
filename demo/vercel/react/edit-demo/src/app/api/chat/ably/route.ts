import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { UIMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { createServerTransport } from '@ably/ai-transport/vercel';
import type { MessageNode } from '@ably/ai-transport';

interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: MessageNode<UIMessage>[];
  history?: MessageNode<UIMessage>[];
  id: string;
  forkOf?: string;
  parent?: string;
}

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const { messages, history, id, turnId, clientId, forkOf, parent } = (await req.json()) as ChatRequestBody;

  const channel = ably.channels.get(id);
  const transport = createServerTransport({ channel });
  const turn = transport.newTurn({ turnId, clientId, parent, forkOf });

  await turn.start();

  let lastUserMsgId: string | undefined;
  if (messages.length > 0) {
    const { msgIds } = await turn.addMessages(messages, { clientId });
    lastUserMsgId = msgIds.at(-1);
  }

  const historyMsgs = (history ?? []).map((h) => h.message);
  const newMsgs = (messages ?? []).map((m) => m.message);
  const allMessages = [...historyMsgs, ...newMsgs];

  const result = streamText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system: 'You are a helpful assistant. Keep responses to one or two sentences.',
    messages: await convertToModelMessages(allMessages),
    abortSignal: turn.abortSignal,
  });

  after(async () => {
    const { reason } = await turn.streamResponse(result.toUIMessageStream(), {
      parent: lastUserMsgId,
    });
    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}
