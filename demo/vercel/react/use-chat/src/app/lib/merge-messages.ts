/**
 * Merge the channel's classified transport events into the `UIMessage[]`
 * conversation the route feeds to the model.
 *
 * The wire carries three shapes that matter here, all on `kind: 'message'`
 * events and all bucketed by `meta.transportMessageId`:
 *
 * - A user message fans out as one wire event per part, each carrying the
 *   whole-message envelope (id, role) plus that one part. Merging the parts
 *   of every event sharing a transport-message-id rebuilds the message; identical
 *   parts (e.g. a redelivered wire) are deduplicated.
 * - Assistant output chunks stream under the assistant message's
 *   transport-message-id. Each bucket merges through the AI SDK's own reducer
 *   (`readUIMessageStream`); the last yielded message is the merged result.
 * - A client's tool resolution (`kind: 'chunk'`) is a `tool-output-*` chunk
 *   addressed to the assistant it amends, so it appends into that assistant's
 *   chunk bucket and the reducer resolves the tool part. A `kind: 'approval'`
 *   input records the decision; after merging, the matching tool part flips
 *   from `approval-requested` to `approval-responded`.
 *
 * `kind: 'regenerate'` inputs name the message the client asked to redo. The
 * agent acts on that; the merge contributes nothing for them.
 * Messages are ordered by the first appearance of their transport-message-id in
 * the (chronological) event stream.
 */

import { isDynamicToolUIPart, isToolUIPart, readUIMessageStream } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { TransportEvent } from '@ably/ai-transport';
import type { VercelApprovalDecision, VercelInput, VercelOutput } from '@ably/ai-transport/vercel';

type VercelEvent = TransportEvent<VercelInput, VercelOutput>;
type UIPart = UIMessage['parts'][number];

/** Stable stringify (sorted object keys) so structurally identical parts compare equal. */
function partKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => partKey(v)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${partKey(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Merge one assistant bucket's chunks through the AI SDK reducer; the last yielded message wins. */
async function mergeChunks(chunks: UIMessageChunk[]): Promise<UIMessage | undefined> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last;
}

/** Flip `approval-requested` tool parts to `approval-responded` where a decision was published. */
function applyApprovals(message: UIMessage, approvals: Map<string, VercelApprovalDecision>): UIMessage {
  const parts = message.parts.map((part): UIPart => {
    if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) return part;
    if (part.state !== 'approval-requested') return part;
    const decision = approvals.get(part.toolCallId);
    if (!decision) return part;
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
 * Merge classified transport events (chronological, oldest first) into the
 * conversation as `UIMessage[]`.
 * @param events - The channel's history events, oldest first.
 * @returns The conversation messages, oldest first.
 */
export async function mergeMessages(events: VercelEvent[]): Promise<UIMessage[]> {
  /** transport-message-ids in first-appearance order. */
  const order: string[] = [];
  /** User messages under assembly, keyed by transport-message-id. */
  const users = new Map<string, { message: UIMessage; partKeys: Set<string> }>();
  /** Assistant chunk buckets, keyed by transport-message-id. */
  const chunkBuckets = new Map<string, UIMessageChunk[]>();
  /** Published approval decisions, keyed by toolCallId. */
  const approvals = new Map<string, VercelApprovalDecision>();

  const register = (id: string): void => {
    if (!users.has(id) && !chunkBuckets.has(id)) order.push(id);
  };

  const appendChunk = (id: string, chunk: UIMessageChunk): void => {
    register(id);
    const bucket = chunkBuckets.get(id);
    if (bucket) bucket.push(chunk);
    else chunkBuckets.set(id, [chunk]);
  };

  const mergeUserMessage = (id: string, payload: UIMessage): void => {
    register(id);
    const existing = users.get(id);
    if (!existing) {
      users.set(id, {
        message: { ...payload, parts: [...payload.parts] },
        partKeys: new Set(payload.parts.map((part) => partKey(part))),
      });
      return;
    }
    for (const part of payload.parts) {
      const key = partKey(part);
      if (existing.partKeys.has(key)) continue;
      existing.partKeys.add(key);
      existing.message.parts.push(part);
    }
  };

  for (const event of events) {
    if (event.kind !== 'message') continue;
    const id = event.meta.transportMessageId;
    if (id === undefined) continue;
    for (const input of event.inputs) {
      switch (input.kind) {
        case 'message': {
          mergeUserMessage(id, input.payload);
          break;
        }
        case 'chunk': {
          appendChunk(id, input.payload);
          break;
        }
        case 'approval': {
          approvals.set(input.payload.toolCallId, input.payload);
          break;
        }
        case 'regenerate': {
          break;
        }
      }
    }
    for (const output of event.outputs) appendChunk(id, output);
  }

  const messages: UIMessage[] = [];
  for (const id of order) {
    const user = users.get(id);
    if (user) {
      messages.push(user.message);
      continue;
    }
    const merged = await mergeChunks(chunkBuckets.get(id) ?? []);
    if (merged) messages.push(applyApprovals(merged, approvals));
  }
  return messages;
}
