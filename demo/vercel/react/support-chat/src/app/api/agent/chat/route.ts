/**
 * Agent chat route — publishes human agent messages to the channel without
 * invoking the AI orchestrator. The human agent's transport POSTs here
 * instead of /api/chat.
 */

import type { UIMessage } from 'ai';
import type { UIMessageChunk } from 'ai';
import Ably from 'ably';
import { createServerTransport } from '@ably/ai-transport/vercel';
import type { EventNode, TreeNode } from '@ably/ai-transport';

interface AgentChatRequestBody {
  turnId: string;
  clientId: string;
  messages: TreeNode<UIMessage>[];
  history?: TreeNode<UIMessage>[];
  amendments?: EventNode<UIMessageChunk>[];
  id: string;
  forkOf?: string;
  parent?: string | null;
}

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const { messages, amendments, id, turnId, clientId, forkOf, parent } =
    (await req.json()) as AgentChatRequestBody;

  const channel = ably.channels.get(id);
  const transport = createServerTransport({ channel });
  const turn = transport.newTurn({ turnId, clientId, parent, forkOf });

  await turn.start();

  if (amendments && amendments.length > 0) {
    await turn.addEvents(amendments);
  }

  if (messages.length > 0) {
    await turn.addMessages(messages, { clientId });
  }

  // No AI — just publish the message and end the turn
  await turn.end('complete');
  transport.close();

  return new Response(null, { status: 200 });
}
