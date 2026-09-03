/**
 * Apply the input that woke the agent onto the conversation the store holds.
 *
 * The store is the conversation; the channel carries what has happened since
 * the last write. That is one wire message — the input `locateInput` found —
 * so this is a small update, not a rebuild:
 *
 * - `kind: 'message'` carries a whole `UIMessage` (a user turn), so it
 *   replaces the message of that id or appends as a new one.
 * - `kind: 'chunk'` is a client's tool resolution: the assistant message it
 *   amends, plus a `tool-output-*` chunk in the AI SDK's own vocabulary. The
 *   chunk replays through the SDK's reducer (`readUIMessageStream`) onto the
 *   message the body names, so the SDK decides what a resolved tool part looks
 *   like.
 * - `kind: 'approval'` names its assistant message and tool call directly.
 *   The SDK has no stream part for a decision, which is why the codec defines
 *   the body — but it does have a `tool-approval-response` chunk, so the
 *   decision is rebuilt as one and replayed through the same reducer. The SDK
 *   owns the state transition, including the `isAutomatic` and `signature`
 *   fields a hand-written flip would drop.
 * - `kind: 'regenerate'` names the message useChat asked to redo. The agent
 *   acts on that; the conversation is unchanged.
 *
 * What is left here is the part no reducer can do for itself: deciding which
 * stored message a body addresses, and putting a message into the list.
 */

import { isDynamicToolUIPart, isToolUIPart, readUIMessageStream } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { VercelInput } from '@ably/ai-transport/vercel';

/**
 * The approval id the SDK keys a decision on: the one it minted on the tool
 * part when it asked. The codec's decision body names the call, not the
 * approval, because the call is what the application addresses.
 * @param message - The message holding the gated call.
 * @param toolCallId - The call the decision answers.
 * @returns The approval id, or `undefined` when that call is not awaiting one.
 */
const approvalIdFor = (message: UIMessage, toolCallId: string): string | undefined => {
  for (const part of message.parts) {
    if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) continue;
    if (part.toolCallId !== toolCallId) continue;
    if (part.state !== 'approval-requested') continue;
    return part.approval.id;
  }
  return undefined;
};

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
        const at = messages.findIndex((message) => message.id === input.payload.messageId);
        const target = at === -1 ? undefined : messages[at];
        // A resolution for a message this conversation never held addresses
        // nothing — a foreign publisher, or a store write that never landed.
        if (target === undefined) break;
        messages[at] = await applyChunk(target, input.payload.chunk);
        break;
      }
      case 'approval': {
        const at = messages.findIndex((message) => message.id === input.payload.messageId);
        const target = at === -1 ? undefined : messages[at];
        if (target === undefined) break;
        const approvalId = approvalIdFor(target, input.payload.toolCallId);
        // No approval pending for that call — a foreign publisher, or a
        // decision the store already holds the answer to.
        if (approvalId === undefined) break;
        messages[at] = await applyChunk(target, {
          type: 'tool-approval-response',
          approvalId,
          approved: input.payload.approved,
          ...(input.payload.reason === undefined ? {} : { reason: input.payload.reason }),
        });
        break;
      }
      case 'regenerate': {
        break;
      }
    }
  }
  return messages;
}
