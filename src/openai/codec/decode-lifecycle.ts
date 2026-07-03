/**
 * OpenAI Responses decode lifecycle policy — mid-stream-join repair.
 *
 * When a client joins a run mid-flight (a second tab, a reconnect, a partial
 * history page) it can catch a family's stream without having seen the
 * `output_item.added` that introduced the item the stream fills. The decoder
 * reconstructs the family's own start on join — a `content_part.added` /
 * `reasoning_summary_part.added` for the part families — but the reducer folds
 * that start (and every following delta) into nothing, because the owner item
 * was never registered. This policy prepends the missing `output_item.added`
 * so the owner item exists before the part opener folds.
 *
 * Which owner to synthesise is read off the stream's re-stamped `part` header:
 * `output_text` / `refusal` parts belong to a message, `reasoning_text` and the
 * summary part belong to a reasoning item. The `function_call_arguments` family
 * needs no repair — its start type *is* `output_item.added`, so the decoder
 * reconstructs the function-call item itself — and it carries no `item_id`
 * header (the id nests in the item envelope), so it is skipped here.
 *
 * Emitting the synthetic `output_item.added` unconditionally would double the
 * item for a client that *did* see the real one (present at the genuine start,
 * or a full history replay): the real discrete event and the synthetic one
 * would both fold. So the policy tracks, per run, which owner items have been
 * introduced — marking the real `output_item.added` as it decodes, and marking
 * each synthetic one it emits — and synthesises only for an unseen item. That
 * also dedupes sibling streams on the same item (e.g. `output_text` at
 * `content[0]` and `refusal` at `content[1]` of one message), where only the
 * first stream's join should introduce the owner. Per-run tracking is cleared
 * on the response's terminal lifecycle events to bound memory; a fresh policy
 * (and its tracking) is built per decoder instance.
 */

import type { Responses } from 'openai/resources/responses/responses';

import { type LifecyclePolicy } from '../../core/codec/index.js';
import type { OpenAIOutput } from './events.js';
import { fItemId, fOutputIndex, fPartType } from './fields.js';

// The part families re-stamp `item_id` / `output_index` / `part` on their stream
// headers; the owner selection reads them. `function_call_arguments` carries
// neither `item_id` nor `part` (its id nests in the item envelope), so both
// reads come back undefined and it is skipped.

const messageOwner = (id: string): Responses.ResponseOutputMessage => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'in_progress',
  content: [],
});

const reasoningOwner = (id: string): Responses.ResponseReasoningItem => ({
  id,
  type: 'reasoning',
  summary: [],
});

const outputItemAdded = (item: Responses.ResponseOutputItem, outputIndex: number): OpenAIOutput => ({
  type: 'response.output_item.added',
  item,
  output_index: outputIndex,
  // Synthetic and unread on decode (the reducer keys on the item id, and Ably
  // serials order the wire), so a fixed placeholder is faithful enough.
  sequence_number: 0,
});

// The owner `output_item.added` a part family's stream is missing on join, or
// undefined when the family needs no repair (no owner to introduce).
const ownerFor = (partType: string | undefined, itemId: string, outputIndex: number): OpenAIOutput | undefined => {
  switch (partType) {
    case 'output_text':
    case 'refusal': {
      return outputItemAdded(messageOwner(itemId), outputIndex);
    }
    case 'reasoning_text':
    case 'summary_text': {
      return outputItemAdded(reasoningOwner(itemId), outputIndex);
    }
    default: {
      return undefined;
    }
  }
};

// Read the owner item id from a discrete output_item envelope's wire data.
const itemIdOf = (data: unknown): string | undefined => {
  if (data === null || typeof data !== 'object') return undefined;
  // CAST: an output_item.added/.done message carries the item envelope as its
  // wire data (trust boundary); the policy reads only its id to track owners.
  const id = (data as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
};

/**
 * Build a fresh OpenAI decode lifecycle policy (with its own per-run owner
 * tracking). Passed to `defineCodec` as the `decodeLifecycle` factory so each
 * decoder instance gets independent state.
 * @returns A {@link LifecyclePolicy} for the OpenAI output union.
 */
export const createResponsesDecodeLifecycle = (): LifecyclePolicy<OpenAIOutput> => {
  // TODO(AIT-742): this per-run owner tracking (and the `LifecycleDiscreteContext.data`
  // it reads) exists only because the reducer's `output_item.added` is a non-idempotent
  // push; making that a find-or-create (like Vercel's `ensureMessage`) would let all of
  // this go, and would also close a reverse-delivery-order duplicate the tracking can't.
  // Parked pending broader PR direction — see notes/openai-codec-build-log.md.
  // Per run: the ids of owner items already introduced (real or synthetic).
  const seenByRun = new Map<string, Set<string>>();
  const seenFor = (runId: string): Set<string> => {
    let set = seenByRun.get(runId);
    if (!set) {
      set = new Set();
      seenByRun.set(runId, set);
    }
    return set;
  };

  const markOwner = (runId: string, { data }: { data: unknown }): OpenAIOutput[] => {
    const id = itemIdOf(data);
    if (id !== undefined) seenFor(runId).add(id);
    return [];
  };

  const clearRun = (runId: string): OpenAIOutput[] => {
    seenByRun.delete(runId);
    return [];
  };

  return {
    onDiscrete: {
      // The real owner envelope decoded from the wire — record it so its stream
      // start doesn't synthesise a duplicate. (A function-call item arrives as a
      // stream, not this discrete event, so it never reaches here.)
      'response.output_item.added': markOwner,
      // Terminal response lifecycle — the run is over; free its tracking.
      'response.completed': clearRun,
      'response.incomplete': clearRun,
      'response.failed': clearRun,
    },
    onStreamStart: (runId, tracker) => {
      const itemId = fItemId.read(tracker.codecHeaders);
      if (itemId === undefined) return [];
      const seen = seenFor(runId);
      if (seen.has(itemId)) return [];
      const owner = ownerFor(
        fPartType.read(tracker.codecHeaders)?.type,
        itemId,
        fOutputIndex.read(tracker.codecHeaders) ?? 0,
      );
      if (owner === undefined) return [];
      seen.add(itemId);
      return [owner];
    },
  };
};
