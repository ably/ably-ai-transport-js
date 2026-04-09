/**
 * Chat API route — receives messages from the client transport's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Supports three tool execution patterns:
 * - Server-executed tools (getWeather): streamText handles execution automatically
 * - Client-executed tools (getLocation): client sends result via view.update()
 * - Approval-required tools (getWeatherForecast): client sends approval via
 *   view.send() with toolApprovals in the body, server patches history to
 *   approval-responded and streamText executes the tool
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { createServerTransport } from '@ably/ai-transport/vercel';
import type { EventsNode, MessageNode } from '@ably/ai-transport';
import { tools } from './tools.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolApproval {
  toolCallId: string;
  toolName: string;
  input: unknown;
  approved: boolean;
  targetMsgId: string;
}

interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: MessageNode<UIMessage>[];
  history?: MessageNode<UIMessage>[];
  events?: EventsNode<UIMessageChunk>[];
  id: string;
  forkOf?: string;
  parent?: string;
  toolApprovals?: ToolApproval[];
}

// ---------------------------------------------------------------------------
// Server-side state
// ---------------------------------------------------------------------------

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

// ---------------------------------------------------------------------------
// Helper: patch tool approvals to approval-responded
// ---------------------------------------------------------------------------

/**
 * Patches `approval-requested` tool parts in the UIMessage history to
 * `approval-responded` (approved) or `output-denied` (denied).
 *
 * This is an ephemeral, server-side-only mutation of the history for the
 * current request. `convertToModelMessages` converts the `approval-responded`
 * state into a `tool-approval-response` model message, which tells `streamText`
 * to execute the tool automatically via its multi-step loop.
 *
 * The trailing user message ("Approved: ...") must be removed from the model
 * messages after conversion — `streamText` only processes pending tool calls
 * when the conversation ends with a tool/assistant message, not a user message.
 *
 * Populates `pendingPublish` with `toolCallId → targetMsgId` entries for
 * cross-turn publishing. After `streamText` executes the tool and the stream
 * completes, the captured tool output is published via `turn.addEvents()`
 * targeting the original assistant message so the client's tree is updated.
 */
function patchToolApprovals(
  pendingPublish: Map<string, string>,
  allMessages: UIMessage[],
  approvals: ToolApproval[],
): void {
  for (const approval of approvals) {
    for (const msg of allMessages) {
      const partIndex = msg.parts.findIndex(
        (p) =>
          (p as { type: string; toolCallId?: string }).type === 'dynamic-tool' &&
          (p as { toolCallId: string }).toolCallId === approval.toolCallId,
      );
      if (partIndex === -1) continue;

      const existing = msg.parts[partIndex] as { approval?: { id: string } };
      const approvalId = existing.approval?.id ?? crypto.randomUUID();

      if (!approval.approved) {
        msg.parts[partIndex] = {
          type: 'dynamic-tool',
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          state: 'output-denied',
          input: approval.input,
          approval: { id: approvalId, approved: false as const },
        };
      } else {
        msg.parts[partIndex] = {
          type: 'dynamic-tool',
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          state: 'approval-responded',
          input: approval.input,
          approval: { id: approvalId, approved: true },
        };
      }

      // targetMsgId comes from the client — it's the x-ably-msg-id of
      // the assistant message containing the approval-requested tool part.
      if (approval.targetMsgId) {
        pendingPublish.set(approval.toolCallId, approval.targetMsgId);
      }
      break;
    }
  }
}

/**
 * On the approval turn, removes the trailing user message ("Approved: ...").
 * `streamText`'s multi-step loop only processes pending tool calls when the
 * conversation ends with a tool/assistant message — a trailing user message
 * causes it to send everything to the model as-is, bypassing tool execution.
 */
function removeTrailingUserMessage(
  modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>,
  approvals: ToolApproval[] | undefined,
): typeof modelMessages {
  if (!approvals || approvals.length === 0) return modelMessages;
  const lastMsg = modelMessages.at(-1);
  if (lastMsg?.role === 'user') return modelMessages.slice(0, -1);
  return modelMessages;
}

/**
 * Returns a copy of the tools with `needsApproval` disabled for any tool
 * that was just approved. Prevents an infinite approval loop when the LLM
 * calls the same tool again in multi-step mode.
 */
function disableApprovalForApprovedTools(approvals: ToolApproval[] | undefined): typeof tools {
  const approvedNames = new Set((approvals ?? []).filter((a) => a.approved).map((a) => a.toolName));
  if (approvedNames.size === 0) return tools;
  return Object.fromEntries(
    Object.entries(tools).map(([name, def]) => [
      name,
      approvedNames.has(name) ? { ...def, needsApproval: false } : def,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const { messages, history, events, id, turnId, clientId, forkOf, parent, toolApprovals } =
    (await req.json()) as ChatRequestBody;

  const channel = ably.channels.get(id);
  const transport = createServerTransport({ channel });

  // Cross-turn publishing state: populated by patchToolApprovals before
  // streamText runs, read by onMessage during the stream to capture outputs.
  const pendingPublish = new Map<string, string>();
  const capturedOutputs = new Map<string, unknown>();

  const onMessage = (msg: Ably.Message) => {
    if (msg.name === 'tool-output-available') {
      const headers = (msg.extras as { headers?: Record<string, string> })?.headers;
      const toolCallId = headers?.['x-domain-toolCallId'];
      if (toolCallId && pendingPublish.has(toolCallId)) {
        const data = msg.data as { output: unknown } | undefined;
        if (data?.output !== undefined) {
          capturedOutputs.set(toolCallId, data.output);
        }
      }
    }
  };

  const turn = transport.newTurn({ turnId, clientId, parent, forkOf, onMessage });

  await turn.start();

  // Publish cross-turn events (tool results targeting existing messages)
  if (events && events.length > 0) {
    await turn.addEvents(events);
  }

  // Publish user messages
  let lastUserMsgId: string | undefined;
  if (messages.length > 0) {
    const { msgIds } = await turn.addMessages(messages, { clientId });
    lastUserMsgId = msgIds.at(-1);
  }

  // Reconstruct full conversation for the LLM
  const historyMsgs = (history ?? []).map((h) => h.message);
  const newMsgs = (messages ?? []).map((m) => m.message);
  const allMessages = [...historyMsgs, ...newMsgs];

  // Handle tool approvals: patch history to approval-responded
  if (toolApprovals && toolApprovals.length > 0) {
    patchToolApprovals(pendingPublish, allMessages, toolApprovals);
  }

  const modelMessages = removeTrailingUserMessage(await convertToModelMessages(allMessages), toolApprovals);

  const effectiveTools = disableApprovalForApprovedTools(toolApprovals);

  const result = streamText({
    model: anthropic('claude-sonnet-4-20250514'),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: modelMessages,
    tools: effectiveTools,
    abortSignal: turn.abortSignal,
  });

  // Stream in background, then publish cross-turn tool outputs
  after(async () => {
    const { reason } = await turn.streamResponse(result.toUIMessageStream(), {
      parent: lastUserMsgId,
    });

    // Publish captured tool outputs targeting the original messages
    for (const [toolCallId, targetMsgId] of pendingPublish) {
      const output = capturedOutputs.get(toolCallId);
      if (output !== undefined) {
        await turn.addEvents([
          {
            kind: 'event',
            msgId: targetMsgId,
            events: [{ type: 'tool-output-available', toolCallId, output, dynamic: true } as UIMessageChunk],
          },
        ]);
      }
    }

    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}
