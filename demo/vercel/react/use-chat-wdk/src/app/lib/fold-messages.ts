/**
 * Fold classified transport events into `UIMessage[]` — the message assembly
 * every workflow activity shares when it needs conversation state (model
 * context, pending-tool classification).
 *
 * The fold buckets `message` events by their wire `codec-message-id` in
 * first-seen order and reduces each bucket with the AI SDK's own reducer
 * (`readUIMessageStream`):
 *
 * - Agent output chunks and client `kind: 'chunk'` tool-resolution inputs are
 *   chunk-shaped already and fold directly. A `tool-output-*` chunk routes to
 *   the bucket that owns its `toolCallId` (a tool activity publishes its
 *   result as its own wire message, but the result belongs on the assistant
 *   message that made the call).
 * - A `kind: 'message'` input carries a whole `UIMessage`; the last payload
 *   per bucket wins, which also dedupes a redelivered echo of the same send.
 * - A `kind: 'approval'` input has no chunk shape of its own; it is applied as
 *   a synthesized `tool-approval-response` chunk against the matching
 *   `tool-approval-request` already in the owning bucket.
 *
 * Output published under an AIT step folds at most one attempt per `step-id`:
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

/** Options for {@link foldMessages}. */
export interface FoldMessagesOptions {
  /** Drop all output stamped with this step-id before folding (the caller's own step, about to be superseded by a fresh attempt). */
  excludeStepId?: string;
}

/** One bucket of chunk-shaped content plus any whole-message payload, keyed by codec-message-id. */
interface Bucket {
  /** The whole `UIMessage` a `kind: 'message'` input carried; last payload wins. */
  message?: UIMessage;
  /** Chunk-shaped events (agent outputs + tool-resolution inputs), in serial order. */
  chunks: UIMessageChunk[];
}

/** The `toolCallId` a chunk carries, read structurally so the check tracks the installed `ai` major. */
function chunkToolCallId(chunk: UIMessageChunk): string | undefined {
  return 'toolCallId' in chunk && typeof chunk.toolCallId === 'string' ? chunk.toolCallId : undefined;
}

/**
 * Reduce a chunk list to the final `UIMessage` state via the AI SDK's own
 * reducer. Undecodable or orphaned chunks are skipped (`terminateOnError`
 * stays false) so a partial stream still folds to its best-known state.
 * @param chunks - The chunk-shaped events, in serial order.
 * @param seed - An initial message to fold onto (a whole-message input).
 * @returns The folded message, or undefined when nothing folded.
 */
export async function foldChunkList(chunks: UIMessageChunk[], seed?: UIMessage): Promise<UIMessage | undefined> {
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
      /* a partial or orphaned chunk sequence folds to its best-known state */
    },
  });
  for await (const state of states) latest = state;
  return latest;
}

/**
 * Fold classified transport events (chronological, e.g. from paging
 * `AgentTransport.history()` to exhaustion) into the conversation's
 * `UIMessage[]`, in first-seen message order.
 * @param events - The classified events, oldest first.
 * @param opts - See {@link FoldMessagesOptions}.
 * @returns The folded messages.
 */
export async function foldMessages(events: WdkTransportEvent[], opts?: FoldMessagesOptions): Promise<UIMessage[]> {
  // Pass 1: the canonical attempt per step-id — the latest step-start-serial
  // wins, so a superseded attempt's output never folds.
  const canonicalAttempt = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'message') continue;
    const { stepId, stepStartSerial } = event.meta;
    if (stepId === undefined || stepStartSerial === undefined) continue;
    const prior = canonicalAttempt.get(stepId);
    if (prior === undefined || stepStartSerial > prior) canonicalAttempt.set(stepId, stepStartSerial);
  }

  // Pass 2: bucket by codec-message-id, routing tool resolutions to the bucket
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
    const key = meta.codecMessageId ?? meta.serial ?? crypto.randomUUID();
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
          bucketFor(key).message = input.payload;
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
          // A wire-only structure signal; it carries no content to fold.
          break;
      }
    }
  }

  // Pass 3: reduce each bucket to its final message state.
  const messages: UIMessage[] = [];
  for (const bucket of buckets.values()) {
    const message = bucket.chunks.length > 0 ? await foldChunkList(bucket.chunks, bucket.message) : bucket.message;
    if (message) messages.push(message);
  }
  return messages;
}
