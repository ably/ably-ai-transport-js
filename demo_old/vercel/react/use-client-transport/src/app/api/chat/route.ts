/**
 * Chat API route — receives messages from the client transport's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Supports three tool execution patterns:
 * - Server-executed tools (getWeather): streamText handles execution automatically
 * - Client-executed tools (getLocation): client sends result via view.update()
 * - Approval-required tools (getWeatherForecast): client sends a ToolApprovalDecision
 *   via view.send() with toolApprovals in the body; prepareApprovalTurn patches
 *   history and tools; streamResponseWithApprovalRedirect routes the resulting
 *   tool output back to the original assistant message.
 */

import { after } from 'next/server';
import { streamText } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import {
  createServerTransport,
  prepareApprovalTurn,
  streamResponseWithApprovalRedirect,
  type ToolApprovalDecision,
} from '@ably/ai-transport/vercel';
import type { EventsNode, MessageNode } from '@ably/ai-transport';
import { tools } from './tools';

interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: MessageNode<UIMessage>[];
  history?: MessageNode<UIMessage>[];
  events?: EventsNode<UIMessageChunk>[];
  id: string;
  forkOf?: string;
  parent?: string;
  toolApprovals?: ToolApprovalDecision[];
}

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const { messages, history, events, id, turnId, clientId, forkOf, parent, toolApprovals } =
    (await req.json()) as ChatRequestBody;

  const channel = ably.channels.get(id);
  const transport = createServerTransport({ channel });
  const turn = transport.newTurn({ turnId, clientId, parent, forkOf, signal: req.signal });

  await turn.start();

  if (events && events.length > 0) {
    await turn.addEvents(events);
  }

  let lastUserMsgId: string | undefined;
  if (messages.length > 0) {
    const { msgIds } = await turn.addMessages(messages, { clientId });
    lastUserMsgId = msgIds.at(-1);
  }

  const allMessages = [...(history ?? []).map((h) => h.message), ...messages.map((m) => m.message)];

  const { modelMessages, tools: effectiveTools } = await prepareApprovalTurn({
    messages: allMessages,
    decisions: toolApprovals,
    tools,
  });

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: modelMessages,
    tools: effectiveTools,
    abortSignal: turn.abortSignal,
  });

  after(async () => {
    const { reason } = await streamResponseWithApprovalRedirect(turn, result.toUIMessageStream(), {
      parent: lastUserMsgId,
      decisions: toolApprovals,
    });
    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}
