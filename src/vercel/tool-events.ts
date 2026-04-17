/**
 * Server-side helper for folding client-shipped events into an in-memory
 * history array before handing it to `convertToModelMessages` / `streamText`.
 *
 * When a client-executed tool resolves, the client stages the resulting
 * `tool-output-available` / `tool-output-error` chunk via
 * `transport.stageEvents(msgId, [...])`. The next send flushes it into the
 * POST body's `events` field. The server republishes the event on the
 * channel via `turn.addEvents`, and must also merge it into the in-memory
 * history so the LLM sees the tool result this turn.
 */

import type * as AI from 'ai';

import type { EventsNode, MessageNode } from '../core/transport/types.js';
import { createAccumulator } from './codec/accumulator.js';

/**
 * Fold a batch of client-shipped events into an in-memory history array.
 *
 * Mirrors the optimistic tree update in
 * `DefaultClientTransport._internalSend` (src/core/transport/client-transport.ts)
 * so the server can rebuild the same message state before handing it to
 * `convertToModelMessages` / `streamText`.
 * @param events - The events shipped by the client.
 * @param nodes - The history messages from the POST body.
 * @returns A new array with tool-result events applied to the matching
 *   messages. Non-targeted messages are passed through unchanged.
 */
export const applyToolEventsToHistory = (
  events: EventsNode<AI.UIMessageChunk>[],
  nodes: MessageNode<AI.UIMessage>[],
): MessageNode<AI.UIMessage>[] => {
  if (events.length === 0) return nodes;
  const eventsByMsgId = new Map(events.map((e) => [e.msgId, e]));

  return nodes.map((node) => {
    const evNode = eventsByMsgId.get(node.msgId);
    if (!evNode) return node;

    const accumulator = createAccumulator();
    accumulator.initMessage(node.msgId, node.message);
    accumulator.processOutputs(
      evNode.events.map((event) => ({
        kind: 'event' as const,
        event,
        messageId: node.msgId,
      })),
    );
    const updated = accumulator.messages.at(-1);
    return updated ? { ...node, message: updated } : node;
  });
};
