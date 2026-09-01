/**
 * Merge a channel's decoded transport events into the conversation's
 * `UIMessage[]`. The transport delivers classified events and merges nothing
 * itself; this helper is the demo's one merge, shared by the worker's
 * activities (model context assembly).
 *
 * How it merges:
 *
 * - `message` events bucket by `meta.transportMessageId`, in first-seen order —
 *   the logical message a wire event belongs to.
 * - Agent outputs and `kind: 'chunk'` inputs (tool resolutions) are UIMessage
 *   chunks; each bucket's chunks replay through the AI SDK's own reducer,
 *   `readUIMessageStream`. A chunk naming a `toolCallId` routes to whichever
 *   bucket already holds that call, not to its own transport-message-id: the
 *   step writer mints a fresh id per publish, so a server tool's output
 *   arrives under an id of its own and would otherwise never reach the
 *   assistant that called it.
 * - `kind: 'message'` inputs carry a whole `UIMessage` (a user turn). Parts
 *   merge per bucket with JSON-equality dedupe, so a redelivered wire event
 *   merges to one message.
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
  /** Approval decisions addressed to this message, applied after the merge. */
  approvals: VercelApprovalDecision[];
}

/** The tool call a chunk addresses, when it names one. */
const chunkToolCallId = (chunk: UIMessageChunk): string | undefined =>
  'toolCallId' in chunk && typeof chunk.toolCallId === 'string' ? chunk.toolCallId : undefined;

/** A tool part in either the `dynamic-tool` or `tool-${name}` representation. */
type ToolPart = ToolUIPart | DynamicToolUIPart;

const isToolPart = (part: UIMessage['parts'][number]): part is ToolPart =>
  (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) && 'toolCallId' in part && 'state' in part;

/**
 * Recursively sort object keys so two values that differ only in key order
 * serialise the same. A redelivered wire event comes back through the codec's
 * decode with its fields in the decoder's order, which need not match the
 * order the publisher wrote them in, and a plain `JSON.stringify` comparison
 * reads those as two different parts.
 * @param value - The value to canonicalise.
 * @returns The value with every nested object's keys in sorted order.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (value === null || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    // CAST: `value` is a non-null object, so indexing it by its own key is safe.
    sorted[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return sorted;
};

/** Part identity for the echo dedupe, insensitive to key order. */
const partKey = (part: UIMessage['parts'][number]): string => JSON.stringify(canonical(part));

/**
 * Merge a whole-message input into the bucket. The first one is taken as the
 * base; later carriers of the same transport-message-id contribute only parts not
 * already present, so a multi-part turn reassembles and a redelivered wire
 * event merges into the message it already contributed to.
 * @param bucket - The bucket to merge into.
 * @param payload - The carrier's message.
 */
const mergeMessage = (bucket: Bucket, payload: UIMessage): void => {
  if (!bucket.message) {
    bucket.message = structuredClone(payload);
    return;
  }
  const existing = new Set(bucket.message.parts.map((part) => partKey(part)));
  for (const part of payload.parts) {
    if (!existing.has(partKey(part))) bucket.message.parts.push(structuredClone(part));
  }
};

/** Replay a bucket's chunks through the AI SDK's reducer; the last snapshot is the message. */
const mergeChunks = async (chunks: readonly UIMessageChunk[]): Promise<UIMessage | undefined> => {
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
 * Merge decoded transport events (history batches, oldest first) into the
 * conversation's messages, in first-seen message order.
 * @param events - The classified transport events, in chronological order.
 * @returns The merged `UIMessage[]`, ready for `convertToModelMessages`.
 */
export const mergeMessages = async (events: readonly VercelTransportEvent[]): Promise<UIMessage[]> => {
  const buckets = new Map<string, Bucket>();
  const bucketByToolCallId = new Map<string, Bucket>();
  const bucketFor = (id: string): Bucket => {
    const existing = buckets.get(id);
    if (existing) return existing;
    const created: Bucket = { chunks: [], approvals: [] };
    buckets.set(id, created);
    return created;
  };
  // A chunk that names a tool call belongs to whichever message already holds
  // that call, wherever the chunk itself was published from.
  const routeChunk = (chunk: UIMessageChunk, fallbackId: string): void => {
    const toolCallId = chunkToolCallId(chunk);
    const owner = toolCallId === undefined ? undefined : bucketByToolCallId.get(toolCallId);
    const bucket = owner ?? bucketFor(fallbackId);
    bucket.chunks.push(chunk);
    if (toolCallId !== undefined && owner === undefined) bucketByToolCallId.set(toolCallId, bucket);
  };

  for (const event of events) {
    if (event.kind !== 'message') continue;
    const id = event.meta.transportMessageId;
    if (id === undefined) continue;
    const bucket = bucketFor(id);
    for (const output of event.outputs) routeChunk(output, id);
    for (const input of event.inputs) {
      switch (input.kind) {
        case 'chunk':
          routeChunk(input.payload, id);
          break;
        case 'message':
          mergeMessage(bucket, input.payload);
          break;
        case 'approval':
          bucket.approvals.push(input.payload);
          break;
        default:
          // 'regenerate' names the message the client asked to redo. The agent
          // acts on it; it contributes nothing to the merged conversation.
          break;
      }
    }
  }

  const messages: UIMessage[] = [];
  for (const bucket of buckets.values()) {
    const message = bucket.message ?? (await mergeChunks(bucket.chunks));
    if (!message) continue;
    for (const approval of bucket.approvals) applyApproval(message, approval);
    messages.push(message);
  }
  return messages;
};
