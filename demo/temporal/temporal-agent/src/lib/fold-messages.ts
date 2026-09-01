/**
 * Fold a channel's decoded transport events into the conversation's
 * `UIMessage[]`. The transport delivers classified events and folds nothing
 * itself; this helper is the demo's one fold, shared by the worker's
 * activities (model context assembly).
 *
 * How it folds:
 *
 * - `message` events bucket by `meta.codecMessageId`, in first-seen order —
 *   the logical message a wire event belongs to.
 * - Agent outputs and `kind: 'chunk'` inputs (tool resolutions) are UIMessage
 *   chunks; each bucket's chunks replay through the AI SDK's own reducer,
 *   `readUIMessageStream`.
 * - `kind: 'message'` inputs carry a whole `UIMessage` (a user turn). Parts
 *   merge per bucket with JSON-equality dedupe, so an optimistic local echo
 *   and its wire echo fold to one message.
 * - `kind: 'approval'` inputs flip the matching tool part from
 *   `approval-requested` to `approval-responded`, carrying the decision.
 */

import { readUIMessageStream } from 'ai';
import type { DynamicToolUIPart, ToolUIPart, UIMessage, UIMessageChunk } from 'ai';
import type { TransportEvent } from '@ably/ai-transport';
import type { VercelApprovalDecision, VercelInput, VercelOutput } from '@ably/ai-transport/vercel';

/** One classified transport event at the Vercel codec's default instantiation. */
export type VercelTransportEvent = TransportEvent<VercelInput, VercelOutput>;

/** The wire fragments collected for one logical message. */
interface Bucket {
  /** UIMessage chunks: agent outputs plus `kind: 'chunk'` tool resolutions, in wire order. */
  chunks: UIMessageChunk[];
  /** The whole message a `kind: 'message'` input carried, parts merged across echoes. */
  message?: UIMessage;
  /** Approval decisions addressed to this message, applied after the fold. */
  approvals: VercelApprovalDecision[];
}

/** A tool part in either the `dynamic-tool` or `tool-${name}` representation. */
type ToolPart = ToolUIPart | DynamicToolUIPart;

const isToolPart = (part: UIMessage['parts'][number]): part is ToolPart =>
  (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) && 'toolCallId' in part && 'state' in part;

/**
 * Merge a whole-message input into the bucket. The first one is taken as the
 * base; later echoes of the same codec-message-id contribute only parts not
 * already present (JSON equality), so the optimistic echo and the wire echo
 * fold to one message.
 */
const mergeMessage = (bucket: Bucket, payload: UIMessage): void => {
  if (!bucket.message) {
    bucket.message = structuredClone(payload);
    return;
  }
  const existing = new Set(bucket.message.parts.map((part) => JSON.stringify(part)));
  for (const part of payload.parts) {
    if (!existing.has(JSON.stringify(part))) bucket.message.parts.push(structuredClone(part));
  }
};

/** Replay a bucket's chunks through the AI SDK's reducer; the last snapshot is the message. */
const foldChunks = async (chunks: readonly UIMessageChunk[]): Promise<UIMessage | undefined> => {
  if (chunks.length === 0) return undefined;
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last;
};

/** Flip the matching `approval-requested` tool part to `approval-responded`. */
const applyApproval = (message: UIMessage, decision: VercelApprovalDecision): void => {
  for (const part of message.parts) {
    if (!isToolPart(part) || part.toolCallId !== decision.toolCallId) continue;
    if (part.state !== 'approval-requested') continue;
    Object.assign(part, {
      state: 'approval-responded',
      approval: {
        id: part.approval.id,
        approved: decision.approved,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      },
    });
  }
};

/**
 * Fold decoded transport events (history batches, oldest first) into the
 * conversation's messages, in first-seen message order.
 * @param events - The classified transport events, in chronological order.
 * @returns The folded `UIMessage[]`, ready for `convertToModelMessages`.
 */
export const foldMessages = async (events: readonly VercelTransportEvent[]): Promise<UIMessage[]> => {
  const buckets = new Map<string, Bucket>();
  for (const event of events) {
    if (event.kind !== 'message') continue;
    const id = event.meta.codecMessageId;
    if (id === undefined) continue;
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { chunks: [], approvals: [] };
      buckets.set(id, bucket);
    }
    bucket.chunks.push(...event.outputs);
    for (const input of event.inputs) {
      switch (input.kind) {
        case 'chunk':
          bucket.chunks.push(input.payload);
          break;
        case 'message':
          mergeMessage(bucket, input.payload);
          break;
        case 'approval':
          bucket.approvals.push(input.payload);
          break;
        default:
          // 'regenerate' names the message the client asked to redo. The agent
          // acts on it; it contributes nothing to the folded conversation.
          break;
      }
    }
  }

  const messages: UIMessage[] = [];
  for (const bucket of buckets.values()) {
    const message = bucket.message ?? (await foldChunks(bucket.chunks));
    if (!message) continue;
    for (const approval of bucket.approvals) applyApproval(message, approval);
    messages.push(message);
  }
  return messages;
};
