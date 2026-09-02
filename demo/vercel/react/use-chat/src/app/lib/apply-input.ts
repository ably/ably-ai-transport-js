/**
 * Apply the input that woke the agent onto the conversation the store holds.
 *
 * The store is the conversation; the channel carries what has happened since
 * the last write. That is one wire message — the input `locateInput` found —
 * so this is a small update, not a rebuild:
 *
 * - `kind: 'message'` carries a whole `UIMessage` (a user turn), so it
 *   replaces the message of that id or appends as a new one.
 * - `kind: 'chunk'` is a client's tool resolution, a `tool-output-*` chunk in
 *   the AI SDK's own vocabulary. It replays through the SDK's reducer
 *   (`readUIMessageStream`) onto the message holding that `toolCallId`, so the
 *   SDK decides what a resolved tool part looks like.
 * - `kind: 'approval'` names its assistant message and tool call directly, and
 *   flips that part from `approval-requested` to `approval-responded`. The
 *   codec defines this body because the SDK has no stream part for it.
 * - `kind: 'regenerate'` names the message useChat asked to redo. The agent
 *   acts on that; the conversation is unchanged.
 */

import { isDynamicToolUIPart, isToolUIPart, readUIMessageStream } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { VercelApprovalDecision, VercelInput } from '@ably/ai-transport/vercel';

type UIPart = UIMessage['parts'][number];

/** Whether a message holds a tool part for the given call. */
const holdsToolCall = (message: UIMessage, toolCallId: string): boolean =>
  message.parts.some((part) => (isToolUIPart(part) || isDynamicToolUIPart(part)) && part.toolCallId === toolCallId);

/** A one-chunk stream — the reducer takes a stream, and a resolution is a single chunk. */
function chunkStream(chunk: UIMessageChunk): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start: (controller) => {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Replay one chunk through the AI SDK's reducer onto a message it already holds. */
async function applyChunk(message: UIMessage, chunk: UIMessageChunk): Promise<UIMessage> {
  let updated = message;
  for await (const next of readUIMessageStream({ message, stream: chunkStream(chunk) })) updated = next;
  return updated;
}

/** Flip one `approval-requested` tool part to `approval-responded`, carrying the decision. */
function applyApproval(message: UIMessage, decision: VercelApprovalDecision): UIMessage {
  const parts = message.parts.map((part): UIPart => {
    if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) return part;
    if (part.state !== 'approval-requested') return part;
    if (part.toolCallId !== decision.toolCallId) return part;
    return {
      ...part,
      state: 'approval-responded' as const,
      approval: {
        id: part.approval.id,
        approved: decision.approved,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      },
    };
  });
  return { ...message, parts };
}

/**
 * Apply a located input's decoded bodies onto the stored conversation.
 * @param stored - The conversation as the store holds it, oldest-first.
 * @param inputs - The decoded inputs the triggering wire message carried, in wire order.
 * @returns The conversation with the input applied, oldest-first.
 */
export async function applyInputs(stored: UIMessage[], inputs: VercelInput[]): Promise<UIMessage[]> {
  const messages = [...stored];
  for (const input of inputs) {
    switch (input.kind) {
      case 'message': {
        const at = messages.findIndex((message) => message.id === input.payload.id);
        if (at === -1) messages.push(input.payload);
        else messages[at] = input.payload;
        break;
      }
      case 'chunk': {
        const at = messages.findIndex((message) => holdsToolCall(message, input.payload.toolCallId));
        const target = at === -1 ? undefined : messages[at];
        // A resolution for a call this conversation never held addresses
        // nothing — a foreign publisher, or a store write that never landed.
        if (target === undefined) break;
        messages[at] = await applyChunk(target, input.payload);
        break;
      }
      case 'approval': {
        const at = messages.findIndex((message) => message.id === input.payload.messageId);
        const target = at === -1 ? undefined : messages[at];
        if (target === undefined) break;
        messages[at] = applyApproval(target, input.payload);
        break;
      }
      case 'regenerate': {
        break;
      }
    }
  }
  return messages;
}
