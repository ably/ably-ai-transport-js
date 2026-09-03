/**
 * Turn the groups `readSince` walked off the channel into the `UIMessage`s
 * `useChat` starts from.
 *
 * The transport demultiplexes and hands back what was published; assembling a
 * message is the application's job, and this is where the demos do it. Nothing
 * here reimplements a reducer: `readUIMessageStream` does every merge.
 *
 * One reducer call per group, never one for the whole walk. The reducer holds
 * the state of a single message and re-ids on `start` without clearing the
 * parts it has accumulated, so a second message in the same call inherits the
 * first one's parts.
 *
 * Each group is one of two shapes:
 *
 * - A **client turn** arrives as `message` inputs, already whole `UIMessage`s.
 *   The wire explodes one message into one event per part, so the parts are
 *   concatenated rather than overwritten: a message carrying a file and some
 *   text arrives as two events and must not lose the file.
 * - An **assistant message** arrives as output chunks, replayed through the
 *   reducer. A `chunk` or `approval` input in the same group resolves a tool
 *   call on it, and both are applied through the reducer too, so the SDK owns
 *   every state transition.
 */

import { isDynamicToolUIPart, isToolUIPart, readUIMessageStream } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { WalkedMessage } from '@ably/ai-transport/vercel';

/** A one-shot stream over some chunks — the reducer takes a stream. */
function chunkStream(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/**
 * Run chunks through the provider's reducer, optionally onto a message it
 * already holds.
 * @param chunks - The chunks to replay, in wire order.
 * @param message - The message to apply them to, when continuing one.
 * @returns The last message state the reducer yields, or `undefined` when it produced none.
 */
async function reduce(chunks: UIMessageChunk[], message?: UIMessage): Promise<UIMessage | undefined> {
  let last = message;
  for await (const next of readUIMessageStream({ ...(message ? { message } : {}), stream: chunkStream(chunks) })) {
    last = next;
  }
  return last;
}

/**
 * The approval id the SDK keys a decision on: the one it minted on the tool
 * part when it asked. The codec's decision body names the call, because the
 * call is what the application addresses.
 * @param message - The message holding the gated call.
 * @param toolCallId - The call the decision answers.
 * @returns The approval id, or `undefined` when that call is not awaiting one.
 */
function approvalIdFor(message: UIMessage, toolCallId: string): string | undefined {
  for (const part of message.parts) {
    if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) continue;
    if (part.toolCallId !== toolCallId) continue;
    if (part.state !== 'approval-requested') continue;
    return part.approval.id;
  }
  return undefined;
}

/**
 * Assemble one walked group.
 * @param group - The group's events, in wire order.
 * @returns The message, or `undefined` when the group produced none.
 */
async function assembleGroup(group: WalkedMessage): Promise<UIMessage | undefined> {
  const chunks: UIMessageChunk[] = [];
  let clientTurn: UIMessage | undefined;
  // Applied after the outputs, because a decision needs the tool part the
  // output chunks build before it can name the approval the SDK minted.
  const decisions: { toolCallId: string; approved: boolean; reason?: string }[] = [];

  for (const walked of group.events) {
    if (walked.direction === 'output') {
      chunks.push(walked.event);
      continue;
    }
    const input = walked.event;
    switch (input.kind) {
      case 'message': {
        clientTurn =
          clientTurn === undefined
            ? { ...input.payload, parts: [...input.payload.parts] }
            : { ...clientTurn, parts: [...clientTurn.parts, ...input.payload.parts] };
        break;
      }
      case 'chunk': {
        chunks.push(input.payload.chunk);
        break;
      }
      case 'approval': {
        decisions.push({
          toolCallId: input.payload.toolCallId,
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

  if (clientTurn !== undefined) return clientTurn;

  let message = await reduce(chunks);
  for (const decision of decisions) {
    if (message === undefined) break;
    const approvalId = approvalIdFor(message, decision.toolCallId);
    // No approval pending for that call — a foreign publisher, or a decision
    // the walked output already carries the answer to.
    if (approvalId === undefined) continue;
    message = await reduce(
      [
        {
          type: 'tool-approval-response',
          approvalId,
          approved: decision.approved,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        },
      ],
      message,
    );
  }
  return message;
}

/**
 * Assemble every group the walk returned.
 * @param groups - The walked groups, oldest first.
 * @returns The messages, oldest first, skipping any group that produced none.
 */
export async function assembleWalkedMessages(groups: readonly WalkedMessage[]): Promise<UIMessage[]> {
  const messages: UIMessage[] = [];
  for (const group of groups) {
    // The events are wire data off a shared channel, so any client's malformed
    // publish reaches the reducer here. Contain a failure to the one message:
    // letting it out would lose the whole conversation.
    try {
      const message = await assembleGroup(group);
      if (message !== undefined) messages.push(message);
    } catch (error) {
      console.warn('assembleWalkedMessages(); dropping a message the reducer rejected', group.id, error);
    }
  }
  return messages;
}
