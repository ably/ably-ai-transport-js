/**
 * OpenAI Responses decode lifecycle policy — mid-stream-join repair.
 *
 * Each output item streams as a bracketed sequence opened by an
 * `output_item.added` that introduces the item — this file calls that event the
 * stream's *opening bracket*. For a message or reasoning item, a part group then
 * opens and streams inside that bracket: a part opener (`content_part.added` /
 * `reasoning_summary_part.added`), then deltas, then done. (Note that a
 * function-call item does not have this two-layer structure: its arguments
 * stream directly under the item with no inner part opener, so its
 * `output_item.added` is the only start its stream has; this means it does not
 * require the mid-stream repair that we describe below.)
 *
 * When a client joins a run mid-flight (a second tab, a reconnect, a partial
 * history page) it can start receiving events partway through a bracket,
 * picking up a part stream without ever seeing the `output_item.added` that
 * opened the bracket. The decoder rebuilds the part's own opener on join, but
 * without the bracket the sequence is still ill-formed: the provider's own
 * reducer (OpenAI's `accumulateResponse`) is strict, and throws on a part
 * opener or delta whose item was never added.
 *
 * This policy is the repair, and it is part of the decoder's contract: the
 * synthesised openers are what make the sequences the decoder hands out well
 * formed at the part level. They do not make the sequence safe to hand
 * straight to OpenAI's own `accumulateResponse`, which pushes on every
 * `output_item.added` and reads content positionally — see the two
 * obligations below. On each stream start it
 * synthesises the missing `output_item.added` and prepends it, so the item
 * exists before the part opener merges. The `synthesise*` helpers build the
 * minimal part-container shell: a `message` for `output_text` / `refusal`
 * parts, a `reasoning` item for `reasoning_text` / summary parts. Which
 * container to build follows from the re-stamped `part` header — it names the
 * part's type, and a fixed correspondence (`synthesiseOpeningBracket`) maps
 * each part type to its container.
 *
 * Synthesis is unconditional and stateless. A client present at the real start,
 * or a sibling part stream on the same item (e.g. an `output_text` and a
 * `refusal` under one message), may re-introduce an item id already seen — so a
 * consumer's merge must treat `output_item.added` as find-or-create on the item
 * id, collapsing redundant adds into the one item. That obligation is what lets
 * the policy stay free of per-run tracking and hold no state.
 *
 * Repairing the opener lands the parts in a consumer's merge, but the joiner may
 * still not see the ones it picked up mid-stream. The rebuilt part opener seeds
 * its slot at the real `content_index`, so when the first part received sits
 * above index 0 the item's positional content has a leading hole until the
 * earlier indices hydrate from history (AIT-1160).
 *
 * So a consumer's merge owes two things this decoder deliberately does not do
 * for it: treat `output_item.added` as find-or-create keyed on the item id
 * rather than appending, and tolerate a positional hole in an item's content
 * rather than indexing straight into it.
 */

import type { Responses } from 'openai/resources/responses/responses';

import { type LifecyclePolicy } from '../../core/codec/index.js';
import type { OpenAIOutput } from './events.js';
import { fItemId, fOutputIndex, fPartDiscriminant } from './fields.js';

// The part groups re-stamp `item_id` / `output_index` / `part` on their stream
// headers; the part-container selection reads them. `function_call_arguments` carries
// neither `item_id` nor `part` (its id nests in the item envelope), so both
// reads come back undefined and it is skipped.

const synthesiseMessagePartContainer = (id: string): Responses.ResponseOutputMessage => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'in_progress',
  content: [],
});

const synthesiseReasoningPartContainer = (id: string): Responses.ResponseReasoningItem => ({
  id,
  type: 'reasoning',
  summary: [],
});

const synthesiseOutputItemAdded = (item: Responses.ResponseOutputItem, outputIndex: number): OpenAIOutput => ({
  type: 'response.output_item.added',
  item,
  output_index: outputIndex,
});

// The `output_item.added` event that opens a part group's bracket — the
// event a part group's stream is missing on join — or undefined when the
// group needs no repair (no bracket to open).
const synthesiseOpeningBracket = (
  partType: string | undefined,
  itemId: string,
  outputIndex: number,
): OpenAIOutput | undefined => {
  switch (partType) {
    case 'output_text':
    case 'refusal': {
      return synthesiseOutputItemAdded(synthesiseMessagePartContainer(itemId), outputIndex);
    }
    case 'reasoning_text':
    case 'summary_text': {
      return synthesiseOutputItemAdded(synthesiseReasoningPartContainer(itemId), outputIndex);
    }
    default: {
      return undefined;
    }
  }
};

/**
 * Build the OpenAI decode lifecycle policy. Passed to `defineCodec` as the
 * `decoderSynthesiseLifecycle` factory; the policy is stateless, so each decoder instance
 * simply gets a fresh (equivalent) object.
 * @returns A {@link LifecyclePolicy} for the OpenAI output union.
 */
export const createResponsesDecodeLifecycle = (): LifecyclePolicy<OpenAIOutput> => ({
  onStreamStart: (_runId, tracker) => {
    const itemId = fItemId.read(tracker.codecHeaders);
    if (itemId === undefined) return [];
    const openingBracket = synthesiseOpeningBracket(
      fPartDiscriminant.read(tracker.codecHeaders)?.type,
      itemId,
      fOutputIndex.read(tracker.codecHeaders) ?? 0,
    );
    return openingBracket === undefined ? [] : [openingBracket];
  },
});
