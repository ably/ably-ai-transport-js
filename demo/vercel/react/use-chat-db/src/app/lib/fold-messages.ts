/**
 * Fold classified transport events into `UIMessage`s with the provider's own
 * reducer (`readUIMessageStream`).
 *
 * The standalone transports deliver decoded events without assembling
 * messages — aggregation is the consumer's job. This module is that consumer:
 * it buckets every `message`-kind event by its wire codec-message-id (delivery
 * order is conversation order, so first-seen order is message order), then
 * folds each bucket:
 *
 * - agent output chunks join the bucket's chunk list;
 * - `{ kind: 'chunk' }` inputs are provider chunks too (a tool resolution
 *   published by a client), so they append to the same chunk list — one fold
 *   path covers both directions;
 * - `{ kind: 'message' }` inputs carry whole `UIMessage`s, one part per wire
 *   event, merged by codec-message-id (part-equality dedupes an optimistic
 *   echo against its wire echo);
 * - `{ kind: 'approval' }` inputs are the one non-provider body: a small step
 *   flips the matching tool part to its approval-responded state.
 *
 * Tool resolutions are routed by `toolCallId` to the bucket holding the tool
 * call: a resumed run streams its `tool-output-*` chunks under a fresh
 * codec-message-id, but the part they resolve lives on the assistant message
 * that made the call.
 *
 * Both sides of the demo fold this way: the client folds older history
 * during hydration, and the agent folds channel history into the model
 * context for `streamText`.
 */

import { isDynamicToolUIPart, isToolUIPart, readUIMessageStream } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { TransportEvent } from '@ably/ai-transport';
import type { VercelApprovalDecision, VercelInput, VercelOutput } from '@ably/ai-transport/vercel';

/** One classified event off the demo's client or agent transport. */
export type ChatTransportEvent = TransportEvent<VercelInput, VercelOutput>;

/** One folded message, paired with the wire codec-message-id it folded under. */
export interface FoldedMessage {
  /** The wire codec-message-id the message's events shared. */
  codecMessageId: string;
  /** The assembled message. */
  message: UIMessage;
}

/** One codec-message-id's accumulated content before folding. */
interface Bucket {
  codecMessageId: string;
  /** Provider chunks, in delivery order: agent outputs plus client tool-resolution chunk inputs. */
  chunks: UIMessageChunk[];
  /** The merged `{ kind: 'message' }` payload, when the bucket is a client turn. */
  message: UIMessage | undefined;
  /** Approval decisions addressed to this bucket's assistant message. */
  approvals: VercelApprovalDecision[];
}

/** Read a chunk's `toolCallId` when it carries one (structural — the chunk union has many arms). */
const toolCallIdOf = (chunk: UIMessageChunk): string | undefined =>
  'toolCallId' in chunk && typeof chunk.toolCallId === 'string' ? chunk.toolCallId : undefined;

/**
 * Recursively sort object keys so two values that differ only in key order
 * serialise the same. An optimistic local echo is the caller's own object; its
 * wire echo comes back from the codec's decode with the fields in the
 * decoder's order, and a plain `JSON.stringify` comparison reads those as two
 * different parts.
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
 * Merge one wire-fanned part-carrier into the bucket's message: same domain
 * id, parts appended in wire order, deduped by part identity. A `UIMessage`
 * input is a batch — the codec fans one wire event per part under a single
 * codec-message-id — so replacing rather than merging would keep only the
 * last part of a multi-part turn.
 * @param existing - The message merged so far, or `undefined` for the first carrier.
 * @param incoming - The next carrier's message.
 * @returns The merged message.
 */
const mergeMessage = (existing: UIMessage | undefined, incoming: UIMessage): UIMessage => {
  if (!existing) return { ...incoming, parts: [...incoming.parts] };
  const seen = new Set(existing.parts.map((part) => partKey(part)));
  const parts = [...existing.parts, ...incoming.parts.filter((part) => !seen.has(partKey(part)))];
  return { ...existing, parts };
};
/**
 * Fold a bucket's chunk list through the provider's reducer. The seed message
 * carries the codec-message-id as a fallback domain id; a `start` chunk that
 * names a `messageId` overrides it.
 * @param codecMessageId - The bucket's wire codec-message-id.
 * @param chunks - The bucket's chunks, in delivery order.
 * @returns The last message state the reducer yielded.
 */
const foldChunks = async (codecMessageId: string, chunks: UIMessageChunk[]): Promise<UIMessage> => {
  const seed: UIMessage = { id: codecMessageId, role: 'assistant', parts: [] };
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last = seed;
  // A partial bucket (a history walk that stopped mid-stream) can present the
  // reducer chunks without their openers; swallow those per-chunk errors and
  // keep what folded — the hydration merge drops partial refolds of stored
  // messages anyway.
  for await (const message of readUIMessageStream({ message: seed, stream, onError: () => undefined })) {
    last = message;
  }
  return last;
};

/**
 * Flip the tool part an approval decision addresses from `approval-requested`
 * to `approval-responded`. A part already resolved (an output landed) is left
 * alone. Approved and denied decisions both land as `approval-responded` —
 * the provider carries the outcome on `approval.approved`.
 * @param message - The folded assistant message.
 * @param decision - The approval decision to apply.
 * @returns The message with the matching part flipped.
 */
const applyApproval = (message: UIMessage, decision: VercelApprovalDecision): UIMessage => ({
  ...message,
  parts: message.parts.map((part): UIMessage['parts'][number] => {
    if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) return part;
    if (part.toolCallId !== decision.toolCallId || part.state !== 'approval-requested') return part;
    return {
      ...part,
      state: 'approval-responded',
      approval: {
        ...part.approval,
        approved: decision.approved,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      },
    };
  }),
});

/**
 * Fold events (oldest-first) into messages via the provider's reducer.
 * @param events - Classified transport events in oldest-first order.
 * @returns The assembled messages paired with their codec-message-ids, in delivery order.
 */
export async function foldMessages(events: ChatTransportEvent[]): Promise<FoldedMessage[]> {
  const buckets = new Map<string, Bucket>();
  /** Which bucket holds each tool call's part, for routing its resolution chunks. */
  const toolCallBuckets = new Map<string, Bucket>();

  const bucketFor = (codecMessageId: string): Bucket => {
    let bucket = buckets.get(codecMessageId);
    if (!bucket) {
      bucket = { codecMessageId, chunks: [], message: undefined, approvals: [] };
      buckets.set(codecMessageId, bucket);
    }
    return bucket;
  };

  const pushChunk = (origin: Bucket, chunk: UIMessageChunk): void => {
    let target = origin;
    const toolCallId = toolCallIdOf(chunk);
    if (toolCallId !== undefined) {
      // A tool-input chunk introduces the call here; a tool-output chunk
      // resolves it wherever it was introduced (a resumed run streams the
      // resolution under a fresh codec-message-id).
      if (chunk.type.startsWith('tool-input-')) toolCallBuckets.set(toolCallId, origin);
      else if (chunk.type.startsWith('tool-output-')) target = toolCallBuckets.get(toolCallId) ?? origin;
    }
    target.chunks.push(chunk);
  };

  for (const event of events) {
    if (event.kind !== 'message' || event.meta.codecMessageId === undefined) continue;
    const bucket = bucketFor(event.meta.codecMessageId);
    for (const input of event.inputs) {
      switch (input.kind) {
        case 'message': {
          bucket.message = mergeMessage(bucket.message, input.payload);
          break;
        }
        case 'chunk': {
          pushChunk(bucket, input.payload);
          break;
        }
        case 'approval': {
          bucket.approvals.push(input.payload);
          break;
        }
        // 'regenerate' carries no body; the structure rides the wire headers.
      }
    }
    for (const output of event.outputs) pushChunk(bucket, output);
  }

  const folded: FoldedMessage[] = [];
  for (const bucket of buckets.values()) {
    let message = bucket.chunks.length > 0 ? await foldChunks(bucket.codecMessageId, bucket.chunks) : bucket.message;
    if (!message) continue;
    for (const approval of bucket.approvals) message = applyApproval(message, approval);
    folded.push({ codecMessageId: bucket.codecMessageId, message });
  }
  return folded;
}
