/**
 * Chat API route — receives messages from the client transport's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Supports three tool execution patterns:
 * - Server-executed tools (getWeather): streamText runs them automatically.
 * - Client-executed tools (getLocation): the client runs them, stages the
 *   output via transport.stageEvents, and ships it in the POST body's
 *   `events` field. We publish it via turn.addEvents here and merge it
 *   into the history that feeds convertToModelMessages.
 * - Approval-required tools (getWeatherForecast): useChat's
 *   addToolApprovalResponse patches the assistant message to
 *   approval-responded. The client ships the patched state via the history
 *   overlay (chat-transport's mergeUseChatMessagesOntoTreeNodes).
 *   extractApprovalDecisionsFromHistory detects the patched parts and
 *   streamResponseWithApprovalRedirect stamps tool-output chunks with
 *   x-ably-amend so the original assistant message receives the output.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import {
  applyToolEventsToHistory,
  createServerTransport,
  extractApprovalDecisionsFromHistory,
  streamResponseWithApprovalRedirect,
} from '@ably/ai-transport/vercel';
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

  // Apply client-shipped events (tool outputs from addToolResult +
  // stageEvents). Publishes them as message.update amendments on the
  // channel so observers and the transport tree see the tool result.
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

  // Reconstruct full conversation for the LLM. Merge tool-result events
  // into history so convertToModelMessages sees the tool results this
  // turn (the client ships them separately to keep history nodes intact).
  const mergedHistory = applyToolEventsToHistory(events ?? [], history ?? []);
  const historyMsgs = mergedHistory.map((h) => h.message);
  const newMsgs = (messages ?? []).map((m) => m.message);
  const allMessages = [...historyMsgs, ...newMsgs];

  // Derive approval decisions from history — useChat's addToolApprovalResponse
  // flipped matching tool parts to `approval-responded` / `output-denied`.
  const decisions = extractApprovalDecisionsFromHistory(history ?? []);

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(allMessages),
    tools,
    abortSignal: turn.abortSignal,
  });

  after(async () => {
    const { reason } = await streamResponseWithApprovalRedirect(turn, result.toUIMessageStream(), {
      parent: lastUserMsgId,
      decisions,
    });
    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}
