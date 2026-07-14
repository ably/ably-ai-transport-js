/**
 * OpenAI Responses decode lifecycle policy — mid-stream-join repair.
 *
 * Each output item streams as a bracketed sequence opened by an
 * `output_item.added` that introduces the item — this file calls that item the
 * stream's *owner*. For a message or reasoning item, a part family then opens
 * and streams inside that bracket: a part opener (`content_part.added` /
 * `reasoning_summary_part.added`), then deltas, then done. (Note that a
 * function-call item does not have this two-layer structure: its arguments
 * stream directly under the item with no inner part opener, so its
 * `output_item.added` is the only start its stream has; this means it does not
 * require the mid-stream repair that we describe below.)
 *
 * When a client joins a run mid-flight (a second tab, a reconnect, a partial
 * history page) it can start receiving events partway through a bracket,
 * picking up a part stream without ever seeing the `output_item.added` that
 * introduced its owner. The decoder rebuilds the part's own opener on join, but
 * the reducer folds that opener — and every following delta — into nothing,
 * because the owner item was never registered.
 *
 * This policy fixes that. On each stream start it synthesises the missing
 * `output_item.added` and prepends it, so the owner exists before the part
 * opener folds. The `synthesise*` helpers build the minimal owner shell: a
 * `message` for `output_text` / `refusal` parts, a `reasoning` item for
 * `reasoning_text` / summary parts. Which owner to build follows from the
 * re-stamped `part` header — it names the part's type, and a fixed
 * correspondence (`synthesiseOwnerAdd`) maps each part type to its owner.
 *
 * Synthesis is unconditional and stateless. A client present at the real start,
 * or a sibling part stream on the same item (e.g. an `output_text` and a
 * `refusal` under one message), may re-introduce an owner id already seen. That
 * is safe because the reducer's `output_item.added` arm (see `reducer.ts`) is
 * find-or-create by id, so redundant adds collapse into the one item — the
 * policy needs no per-run owner tracking and holds no state.
 *
 * Repairing the fold lands the parts in the projection, but the joiner may
 * still not see the ones it picked up mid-stream. The opener seeds its slot at
 * the real `content_index`, so when the first part received sits above index 0
 * the item's positional array has a leading hole, which `getMessages` (see
 * `reducer.ts`) compacts away until the earlier indices hydrate from history
 * (AIT-1160).
 */

import type { Responses } from 'openai/resources/responses/responses';

import { type LifecyclePolicy } from '../../core/codec/index.js';
import type { OpenAIOutput } from './events.js';
import { fItemId, fOutputIndex, fPartDiscriminant } from './fields.js';

// The part families re-stamp `item_id` / `output_index` / `part` on their stream
// headers; the owner selection reads them. `function_call_arguments` carries
// neither `item_id` nor `part` (its id nests in the item envelope), so both
// reads come back undefined and it is skipped.

const synthesiseMessageOwnerItem = (id: string): Responses.ResponseOutputMessage => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'in_progress',
  content: [],
});

const synthesiseReasoningOwnerItem = (id: string): Responses.ResponseReasoningItem => ({
  id,
  type: 'reasoning',
  summary: [],
});

const synthesiseOutputItemAdded = (item: Responses.ResponseOutputItem, outputIndex: number): OpenAIOutput => ({
  type: 'response.output_item.added',
  item,
  output_index: outputIndex,
});

// The `output_item.added` event introducing a part family's owner item — the
// event a part family's stream is missing on join — or undefined when the
// family needs no repair (no owner to introduce).
const synthesiseOwnerAdd = (
  partType: string | undefined,
  itemId: string,
  outputIndex: number,
): OpenAIOutput | undefined => {
  switch (partType) {
    case 'output_text':
    case 'refusal': {
      return synthesiseOutputItemAdded(synthesiseMessageOwnerItem(itemId), outputIndex);
    }
    case 'reasoning_text':
    case 'summary_text': {
      return synthesiseOutputItemAdded(synthesiseReasoningOwnerItem(itemId), outputIndex);
    }
    default: {
      return undefined;
    }
  }
};

/**
 * Build the OpenAI decode lifecycle policy. Passed to `defineCodec` as the
 * `decodeLifecycle` factory; the policy is stateless, so each decoder instance
 * simply gets a fresh (equivalent) object.
 * @returns A {@link LifecyclePolicy} for the OpenAI output union.
 */
export const createResponsesDecodeLifecycle = (): LifecyclePolicy<OpenAIOutput> => ({
  onStreamStart: (_runId, tracker) => {
    const itemId = fItemId.read(tracker.codecHeaders);
    if (itemId === undefined) return [];
    const ownerAdd = synthesiseOwnerAdd(
      fPartDiscriminant.read(tracker.codecHeaders)?.type,
      itemId,
      fOutputIndex.read(tracker.codecHeaders) ?? 0,
    );
    return ownerAdd === undefined ? [] : [ownerAdd];
  },
});
