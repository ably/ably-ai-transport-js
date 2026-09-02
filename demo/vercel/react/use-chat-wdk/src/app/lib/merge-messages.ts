/**
 * Merge classified transport events into `UIMessage[]` — the message assembly
 * every workflow activity shares when it needs conversation state (model
 * context, pending-tool classification).
 *
 * The merge buckets `message` events by their wire `transport-message-id` in
 * first-seen order and reduces each bucket with the AI SDK's own reducer
 * (`readUIMessageStream`):
 *
 * - Agent output chunks and client `kind: 'chunk'` tool-resolution inputs are
 *   chunk-shaped already and merge directly. A `tool-output-*` chunk routes to
 *   the bucket that owns its `toolCallId` (a tool activity publishes its
 *   result as its own wire message, but the result belongs on the assistant
 *   message that made the call).
 * - A `kind: 'message'` input carries a `UIMessage`. The codec fans a
 *   multi-part turn out one wire event per part under one transport-message-id,
 *   so carriers merge by part rather than replacing, and an echo of a part
 *   already held is dropped.
 * - A `kind: 'approval'` input has no chunk shape of its own; it is applied as
 *   a synthesized `tool-approval-response` chunk against the matching
 *   `tool-approval-request` already in the owning bucket.
 *
 * Output published under an AIT step merges at most one attempt per `step-id`:
 * the canonical attempt is the one with the latest `step-start-serial`, so a
 * durable retry's output supersedes the dead attempt's instead of appending
 * beside it. `excludeStepId` additionally drops one step's output entirely —
 * an inference retry excludes its own step when assembling model context,
 * because the attempt it is about to publish supersedes that output.
 */

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import type { TransportEvent } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';

/** One classified event off the Vercel-codec agent transport. */
export type WdkTransportEvent = TransportEvent<VercelInput, VercelOutput>;

/** Options for {@link mergeMessages}. */
export interface MergeMessagesOptions {
  /** Drop all output stamped with this step-id before merging (the caller's own step, about to be superseded by a fresh attempt). */
  excludeStepId?: string;
}

/** One bucket of chunk-shaped content plus any whole-message payload, keyed by transport-message-id. */
interface Bucket {
  /** The whole `UIMessage` a `kind: 'message'` input carried; last payload wins. */
  message?: UIMessage;
  /** Chunk-shaped events (agent outputs + tool-resolution inputs), in serial order. */
  chunks: UIMessageChunk[];
}

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
 * Merge a whole-message input into the bucket. A `UIMessage` input is a batch
 * — the codec fans one wire event per part under a single transport-message-id —
 * so replacing rather than merging would keep only the last part of a
 * multi-part turn. Parts already present are dropped, which is what merges an
 * redelivery of a part already held into the message that has it.
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

/** The `toolCallId` a chunk carries, read structurally so the check tracks the installed `ai` major. */
function chunkToolCallId(chunk: UIMessageChunk): string | undefined {
  return 'toolCallId' in chunk && typeof chunk.toolCallId === 'string' ? chunk.toolCallId : undefined;
}

/**
 * Reduce a chunk list to the final `UIMessage` state via the AI SDK's own
 * reducer. Undecodable or orphaned chunks are skipped (`terminateOnError`
 * stays false) so a partial stream still merges to its best-known state.
 * @param chunks - The chunk-shaped events, in serial order.
 * @param seed - An initial message to merge onto (a whole-message input).
 * @returns The merged message, or undefined when nothing merged.
 */
export async function mergeChunkList(chunks: UIMessageChunk[], seed?: UIMessage): Promise<UIMessage | undefined> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let latest = seed;
  const states = readUIMessageStream({
    ...(seed === undefined ? {} : { message: seed }),
    stream,
    onError: () => {
      /* a partial or orphaned chunk sequence merges to its best-known state */
    },
  });
  for await (const state of states) latest = state;
  return latest;
}

/**
 * Merge classified transport events (chronological, e.g. from paging
 * `AgentTransport.history()` to exhaustion) into the conversation's
 * `UIMessage[]`, in first-seen message order.
 * @param events - The classified events, oldest first.
 * @param opts - See {@link MergeMessagesOptions}.
 * @returns The merged messages.
 */
export async function mergeMessages(events: WdkTransportEvent[], opts?: MergeMessagesOptions): Promise<UIMessage[]> {
  // Pass 1: the canonical attempt per step-id — the latest step-start-serial
  // wins, so a superseded attempt's output never merges.
  const canonicalAttempt = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'message') continue;
    const { stepId, stepStartSerial } = event.meta;
    if (stepId === undefined || stepStartSerial === undefined) continue;
    const prior = canonicalAttempt.get(stepId);
    if (prior === undefined || stepStartSerial > prior) canonicalAttempt.set(stepId, stepStartSerial);
  }

  // Pass 2: bucket by transport-message-id, routing tool resolutions to the bucket
  // that owns their toolCallId.
  const buckets = new Map<string, Bucket>();
  const bucketByToolCallId = new Map<string, Bucket>();
  const bucketFor = (key: string): Bucket => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const created: Bucket = { chunks: [] };
    buckets.set(key, created);
    return created;
  };
  const routeChunk = (chunk: UIMessageChunk, fallbackKey: string): void => {
    const toolCallId = chunkToolCallId(chunk);
    const owner = toolCallId === undefined ? undefined : bucketByToolCallId.get(toolCallId);
    const bucket = owner ?? bucketFor(fallbackKey);
    bucket.chunks.push(chunk);
    if (toolCallId !== undefined && owner === undefined) bucketByToolCallId.set(toolCallId, bucket);
  };

  for (const event of events) {
    if (event.kind !== 'message') continue;
    const { meta } = event;
    const key = meta.transportMessageId ?? meta.serial ?? crypto.randomUUID();
    const excluded = opts?.excludeStepId !== undefined && meta.stepId === opts.excludeStepId;
    const superseded =
      meta.stepId !== undefined &&
      meta.stepStartSerial !== undefined &&
      canonicalAttempt.get(meta.stepId) !== meta.stepStartSerial;
    if (!excluded && !superseded) {
      for (const output of event.outputs) routeChunk(output, key);
    }
    for (const input of event.inputs) {
      switch (input.kind) {
        case 'message':
          bucketFor(key).message = mergeMessage(bucketFor(key).message, input.payload);
          break;
        case 'chunk':
          routeChunk(input.payload, key);
          break;
        case 'approval': {
          // The decision has no chunk shape of its own; synthesize the AI
          // SDK's tool-approval-response against the request already in the
          // owning bucket, at this event's chronological position. Without a
          // matching request there is nothing the reducer could apply it to.
          const owner = bucketByToolCallId.get(input.payload.toolCallId);
          const request = owner?.chunks.find(
            (chunk) => chunk.type === 'tool-approval-request' && chunk.toolCallId === input.payload.toolCallId,
          );
          if (owner && request && request.type === 'tool-approval-request') {
            owner.chunks.push({
              type: 'tool-approval-response',
              approvalId: request.approvalId,
              approved: input.payload.approved,
              ...(input.payload.reason === undefined ? {} : { reason: input.payload.reason }),
            });
          }
          break;
        }
        case 'regenerate':
          // 'regenerate' names the message the client asked to redo; the agent acts
          // on it and the merge contributes nothing.
          break;
      }
    }
  }

  // Pass 3: reduce each bucket to its final message state.
  const messages: UIMessage[] = [];
  for (const bucket of buckets.values()) {
    const message = bucket.chunks.length > 0 ? await mergeChunkList(bucket.chunks, bucket.message) : bucket.message;
    if (message) messages.push(message);
  }
  return messages;
}
