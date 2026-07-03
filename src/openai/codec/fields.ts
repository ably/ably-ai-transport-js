/**
 * Shared OpenAI Responses codec header-field bindings.
 *
 * Each field binds a codec header key to its value type once (via the core
 * `HeaderField` bindings); the output descriptors and the decode-lifecycle repair
 * read and write through these bindings, so a header key cannot drift between
 * the encode and decode side, and neither module redeclares them. Domain field
 * names live in the codec layer, not core, per the header-discipline rule.
 */

import type { Responses } from 'openai/resources/responses/responses';

import { jsonField, strField } from '../../core/codec/index.js';

/**
 * Owner item id, re-stamped on every streamed phase (the transport stream id is
 * opaque, so the decoded start / deltas carry this for the reducer to route on).
 */
export const fItemId = strField('item_id');
/** The item's position in the response's output array. */
export const fOutputIndex = jsonField<number, 'output_index'>('output_index');
/** Content-part slot index within an item (output_text / refusal / reasoning_text). */
export const fContentIndex = jsonField<number, 'content_index'>('content_index');
/** The content part opened on a content-part stream's start. */
export const fPart = jsonField<Responses.ResponseContentPartAddedEvent['part'], 'part'>('part');
/** Summary-part slot index within a reasoning item (one item emits one or more indexed summary parts). */
export const fSummaryIndex = jsonField<number, 'summary_index'>('summary_index');
/** The summary part opened on the reasoning-summary stream's start. */
export const fSummaryPart = jsonField<Responses.ResponseReasoningSummaryPartAddedEvent.Part, 'part'>('part');
/**
 * Type-agnostic read of the `part` header's discriminant. {@link fPart} and
 * {@link fSummaryPart} bind the same key with different, non-overlapping part
 * types, so neither can read the other's value; this reads only `.type`, which
 * every part carries, for code that just needs to tell the part families apart
 * (the mid-stream-join owner selection in `decode-lifecycle.ts`).
 */
export const fPartType = jsonField<{ type: string }, 'part'>('part');
/**
 * The function-call item envelope, carried on the fn-args stream start (its slot
 * is the item's own `arguments`, so there is no `*_part.added` opener). Re-stamped
 * on every append, it is the decode-side source of item_id / call_id / name.
 */
export const fItem = jsonField<Responses.ResponseOutputItem, 'item'>('item');

/**
 * Per-slot stream id for the content-part families: item_id + content_index.
 * Purely the transport uniqueness handle — the reducer never parses it (it routes
 * on the re-stamped item_id / content_index fields).
 * @param c - The chunk carrying the item id and content index.
 * @param c.item_id - The owner item id.
 * @param c.content_index - The content-part slot index.
 * @returns The composite stream id.
 */
export const composeItemContent = (c: { item_id: string; content_index: number }): string =>
  `${c.item_id}:${String(c.content_index)}`;
