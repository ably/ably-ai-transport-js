/**
 * Chat API route — receives messages from the client transport's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Supports three tool execution patterns:
 * - Server-executed tools (getWeather): streamText handles execution automatically
 * - Client-executed tools (getLocation): client sends result via addToolResult
 * - Approval-required tools (getWeatherForecast): useChat's addToolApprovalResponse
 *   patches the message to approval-responded and sends via ChatTransport.
 *   The server detects approval-responded tool parts in history and publishes
 *   the tool result via addEvents after execution so the transport tree is updated.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { createServerTransport } from '@ably/ai-transport/vercel';
import type { MessageNode, Turn } from '@ably/ai-transport';
import { tools } from './tools';

/** Shape of the POST body sent by the client transport. */
interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: MessageNode<UIMessage>[];
  history?: MessageNode<UIMessage>[];
  chatId: string;
  forkOf?: string;
  parent?: string;
}

/** Tracks a tool call that was approved and needs cross-turn publishing. */
interface PendingApproval {
  /** The x-ably-msg-id of the original assistant message containing the tool call. */
  targetMsgId: string;
  /** The tool output captured from the stream, or undefined if not yet received. */
  output?: unknown;
}

// Server-side Ably client — uses API key directly (trusted environment).
const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const { messages, history, chatId, turnId, clientId, forkOf, parent } = (await req.json()) as ChatRequestBody;
  const channel = ably.channels.get(chatId);

  const transport = createServerTransport({ channel });
  // Detect approval-responded tool parts in history — these need
  // cross-turn publishing after the tool executes.
  const pendingApprovals = findPendingApprovals(history ?? []);

  const onMessage = (msg: Ably.Message) => {
    if (msg.name === 'tool-output-available' && pendingApprovals.size > 0) {
      const headers = (msg.extras as { headers?: Record<string, string> })?.headers;
      const toolCallId = headers?.['x-domain-toolCallId'];
      if (toolCallId) {
        const pending = pendingApprovals.get(toolCallId);
        if (pending) {
          // capture output for a pending approval
          const data = msg.data as { output: unknown } | undefined;
          if (data?.output !== undefined) {
            pending.output = data.output;
          }
        }
      }
    }
  };

  const turn = transport.newTurn({ turnId, clientId, parent, forkOf, onMessage, signal: req.signal });

  await turn.start();

  // Publish user messages (if any).
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
    model: anthropic('claude-sonnet-4-6'),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(allMessages),
    tools,
    abortSignal: turn.abortSignal,
  });

  // Stream in background, then publish cross-turn tool outputs.
  after(async () => {
    const { reason } = await turn.streamResponse(result.toUIMessageStream(), {
      parent: lastUserMsgId,
    });

    await publishApprovedToolResults(pendingApprovals, turn);

    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}

/**
 * Scan history for tool parts that need cross-turn publishing:
 *
 * - `approval-responded`: the user approved a tool call. The output will
 *   be captured from the stream when streamText executes the tool.
 * - `output-available` on a client-executed tool: the client ran the tool
 *   (e.g. geolocation) and patched the result via addToolResult. The output
 *   is already in the history but hasn't been published to the channel
 *   targeting the original message.
 *
 * The output field is pre-populated for client-executed results and filled
 * later by onMessage for approval-responded parts.
 */
function findPendingApprovals(history: MessageNode<UIMessage>[]): Map<string, PendingApproval> {
  const pending = new Map<string, PendingApproval>();

  // Only scan the last assistant message — earlier ones are already resolved.
  const node = history.findLast((n) => n.message.role === 'assistant');
  if (!node) return pending;
  for (const part of node.message.parts) {
    const p = part as { type: string; state: string; toolCallId: string; output?: unknown };
    if (p.type !== 'dynamic-tool') continue;

    if (p.state === 'approval-responded') {
      // Approval — output will be captured from the stream
      pending.set(p.toolCallId, { targetMsgId: node.msgId });
    }

    if (p.state === 'output-available' && p.output !== undefined) {
      // Client-executed tool result — output already in history from
      // useChat's addToolResult, needs publishing to the channel
      pending.set(p.toolCallId, { targetMsgId: node.msgId, output: p.output });
    }
  }
  return pending;
}

/**
 * Publish tool outputs from approved tool calls to the channel, targeting the
 * original assistant message. This updates the transport tree so the stale
 * `approval-requested` part becomes `output-available` with real data.
 */
async function publishApprovedToolResults(
  pendingApprovals: Map<string, PendingApproval>,
  turn: Turn<UIMessageChunk, UIMessage>,
): Promise<void> {
  for (const [toolCallId, { targetMsgId, output }] of pendingApprovals) {
    if (output === undefined) {
      continue;
    }

    await turn.addEvents([
      {
        kind: 'event',
        msgId: targetMsgId,
        events: [{ type: 'tool-output-available', toolCallId, output, dynamic: true } as UIMessageChunk],
      },
    ]);
  }
}
