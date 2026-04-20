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
 *   approval-responded. The client ships the patched state via the
 *   history overlay (chat-transport's mergeUseChatMessagesOntoTreeNodes).
 *   We detect it here via findPendingApprovals, capture the tool output
 *   from the stream via onMessage, then republish it via addEvents
 *   targeting the ORIGINAL assistant msg-id so the original message ends
 *   up with the resolved tool part.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { applyToolEventsToHistory, createServerTransport } from '@ably/ai-transport/vercel';
import type { EventsNode, MessageNode, Turn } from '@ably/ai-transport';
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

/**
 * Tracks an approved tool call that needs cross-turn publishing. The
 * output field is populated by the onMessage interceptor once streamText
 * produces the tool-output-available chunk.
 */
interface PendingApproval {
  /** x-ably-msg-id of the original assistant message that carried the tool call. */
  targetMsgId: string;
  /** Captured from the stream once the server-side tool runs. */
  output?: unknown;
}

// Server-side Ably client — uses API key directly (trusted environment).
const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const { messages, history, events, chatId, turnId, clientId, forkOf, parent } = (await req.json()) as ChatRequestBody;
  const channel = ably.channels.get(chatId);

  const transport = createServerTransport({ channel });

  // Detect approval-responded tool parts in history. These are the
  // approvals the user just granted — we'll capture their outputs from
  // the stream and republish targeting the original message.
  const pendingApprovals = findPendingApprovals(history ?? []);

  // Intercept tool-output chunks as they flow through turn.streamResponse
  // so we can capture outputs for pending approvals.
  const onMessage = (msg: Ably.Message) => {
    if (msg.name !== 'tool-output-available' || pendingApprovals.size === 0) return;
    const headers = (msg.extras as { headers?: Record<string, string> })?.headers;
    const toolCallId = headers?.['x-domain-toolCallId'];
    if (!toolCallId) return;
    const pending = pendingApprovals.get(toolCallId);
    if (!pending) return;
    const data = msg.data as { output: unknown } | undefined;
    if (data?.output !== undefined) {
      pending.output = data.output;
    }
  };

  const turn = transport.newTurn({ turnId, clientId, parent, forkOf, onMessage, signal: req.signal });

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

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(allMessages),
    tools,
    abortSignal: turn.abortSignal,
  });

  // Stream the response over Ably in the background using after().
  // Pass parent explicitly — the assistant response is a child of the
  // last user message.
  after(async () => {
    const { reason } = await turn.streamResponse(result.toUIMessageStream(), {
      parent: lastUserMsgId,
    });

    // After the main stream finishes, publish the captured approval
    // outputs as amendments targeting the ORIGINAL assistant messages.
    // This stitches the resolved tool part onto the message that
    // contained the approval request.
    await publishApprovedToolResults(pendingApprovals, turn);

    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}

/**
 * Scan the last assistant message for `dynamic-tool` parts in
 * `approval-responded` state — these are the approvals the user just
 * granted that need cross-turn publishing once the tool executes.
 *
 * Output is captured later (by the onMessage interceptor) as streamText
 * emits tool-output-available chunks.
 *
 * NOTE: We intentionally do NOT also scan for `output-available` parts
 * on client-executed tools. Those ship via the explicit `events` POST
 * field and are published via turn.addEvents at the top of the handler.
 * Scanning here would double-publish.
 */
function findPendingApprovals(history: MessageNode<UIMessage>[]): Map<string, PendingApproval> {
  const pending = new Map<string, PendingApproval>();

  let lastAssistantIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].message.role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return pending;

  const node = history[lastAssistantIdx];
  for (const part of node.message.parts) {
    if (part.type !== 'dynamic-tool') continue;
    const p = part as { type: string; state: string; toolCallId: string };
    if (p.state === 'approval-responded') {
      pending.set(p.toolCallId, { targetMsgId: node.msgId });
    }
  }
  return pending;
}

/**
 * Publish captured tool outputs as amendments on the channel, targeting
 * the original assistant message's msg-id. Transitions the original
 * tool part from `approval-responded` (or `approval-requested`) to
 * `output-available` with the real output.
 */
async function publishApprovedToolResults(
  pendingApprovals: Map<string, PendingApproval>,
  turn: Turn<UIMessageChunk, UIMessage>,
): Promise<void> {
  for (const [toolCallId, { targetMsgId, output }] of pendingApprovals) {
    if (output === undefined) continue;
    await turn.addEvents([
      {
        kind: 'event',
        msgId: targetMsgId,
        events: [{ type: 'tool-output-available', toolCallId, output, dynamic: true } as UIMessageChunk],
      },
    ]);
  }
}
