/**
 * OpenAI Responses reducer.
 *
 * Pure `(init, fold, getMessages)` over the `OpenAIInput | OpenAIOutput` union.
 * Folds the agent's Responses event stream — and the client's user-message
 * turn — into a per-node projection of OpenAI items, exposed as one
 * {@link OpenAITurn} per node.
 *
 * Input contract. The reducer folds a serial-ordered *subsequence* of one
 * conversation's decoded events (the transport delivers each event once, in
 * canonical serial order — see the core `Reducer` contract). It does NOT assume
 * it starts at `response.created` or sees every event: it may join a run
 * mid-stream or hold only a suffix of history. For any stream it does receive,
 * though, the decoder reconstructs that stream's opener (`content_part.added` /
 * `reasoning_summary_part.added`) before its deltas — even on a mid-stream join
 * (see `buildStart` in `src/core/codec/output-descriptor-decoder.ts`) — and `decode-lifecycle.ts`
 * synthesises the owning `output_item.added` before the opener folds. So a slot
 * is always seeded before its deltas fold: the delta / `.done` arms only ever
 * mutate an existing slot, never create one. The one thing it must tolerate is
 * an *entirely absent* earlier-index stream — each content slot is its own wire
 * stream (`item_id:content_index`), so a partially-loaded run can fold
 * `content_index=1` without `content_index=0`, leaving a positional hole.
 * That hole is transient internal state — the per-node WireLog re-densifies
 * once the earlier wire pages in — and `getMessages` compacts any residual hole
 * to a dense prefix on the way out, so no consumer sees it.
 *
 * Deviations from OpenAI's accumulator. The fold mirrors OpenAI's own stream
 * reduction (`openai/lib/responses/ResponseAccumulator`), diverging only where
 * our wire model requires it:
 * 1. Keys items on `item_id`, not positional `output_index` — a node
 *    accumulates a whole run (several `/responses` calls) where `output_index`
 *    collides; `item_id` is unique across the projection.
 * 2. Folds a subsequence, not the whole stream from `response.created` — OpenAI
 *    bootstraps only from `response.created`; we may join late or replay a
 *    history suffix.
 * 3. Lenient, not strict, on an unseen slot/item — OpenAI throws ("missing
 *    output/content at index N"); we skip. (This is what lets a positional hole
 *    exist internally at all — compacted at `getMessages` — where OpenAI never
 *    holes because it throws first.)
 * 4. Idempotent owner add (find-or-create), not `push` — `decode-lifecycle.ts`
 *    can re-synthesise an `output_item.added` for a late joiner, so an id may be
 *    added more than once; we keep the first.
 * 5. `output_item.done` finalises `status` in place, not by cloning the whole
 *    finalised item — our done is wire-slimmed (content already folded from the
 *    streams), so it applies only `status`, a message's per-part `logprobs`, and
 *    a reasoning item's `encrypted_content`.
 * 6. Response-lifecycle and stream-`error` events fold to nothing — OpenAI folds
 *    them into the `Response` snapshot; we observe run outcome out-of-band (the
 *    transport run-end event; AIT-1113 will map it from the raw stream).
 * 7. Adds `function_call_output` — no Responses-stream equivalent (OpenAI
 *    surfaces tool output only as next-turn input); we append it to the turn
 *    beside its `function_call`.
 *
 * What it folds, by use case (it sees discrete decoded events, not the streams
 * they arrived on):
 * - assistant text — `output_text.delta` / `.done`;
 * - refusals — `refusal.delta` / `.done`;
 * - raw reasoning text — `reasoning_text.delta` / `.done`;
 * - a reasoning model's summary — `reasoning_summary_text.delta` / `.done`, into
 *   the reasoning item's `summary`;
 * - server-side function calls — `function_call_arguments.delta` / `.done` into
 *   the call's `arguments`, plus the codec's own `function_call_output`.
 * `output_item.added` / `.done` seed and finalise each item;
 * `content_part.added` / `reasoning_summary_part.added` open a slot at its
 * `content_index` / `summary_index`.
 *
 * Everything else folds to nothing (the `foldOutput` default branch mirrors
 * this): dropped-at-encode framing — the response-lifecycle events and the
 * stream-level `error` (deviation 6) — and not-modelled-yet events kept for
 * graceful forward-compat: the remaining Responses surfaces (hosted tools and
 * further modalities, AIT-1121).
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { CodecEvent, CodecMessage, ReducerMeta } from '../../core/codec/index.js';
import type { OpenAIInput, OpenAIItem, OpenAIOutput, OpenAITurn } from './events.js';
import { isModelledOutputItem } from './events.js';

/**
 * Per-node projection: the node's turn-in-progress, embedded as a
 * {@link CodecMessage} so `getMessages` can read it with no reassembly, plus
 * the reducer's own item index for delta accumulation. Absent until the first
 * event carrying a codec-message-id folds — there is no role or
 * codec-message-id to speak of before that, so the projection starts with no
 * entry at all rather than a guessed one; {@link ensureEntry} creates it, with
 * the real values, on first contact. An existing entry doesn't by itself mean
 * the turn has any items yet — see `getMessages`.
 */
export interface OpenAIProjection {
  /**
   * The node's turn-in-progress; absent before the first event carrying a
   * codec-message-id.
   *
   * The turn's items are appended, never positionally slotted, so
   * `entry.message.items` is never sparse. Their *positional* arrays can be,
   * transiently: an output message's `content`, and a reasoning item's
   * `content` (reasoning-text) and `summary`, are slotted by the wire's
   * `content_index` / `summary_index` (see the `*_part.added` arms), so a
   * partially-loaded run that has folded a later index but not an earlier one
   * holds a leading hole. This is internal state only — see `getMessages` for
   * how the hole is re-densified and compacted so it is never exposed.
   */
  entry?: CodecMessage<OpenAITurn> & {
    /** Maps an output item's id to the live (mutable) item in `entry.message.items`, for delta accumulation. */
    byItemId: Map<string, Responses.ResponseOutputItem>;
  };
}

/**
 * Build an empty projection for a node.
 * @returns A fresh {@link OpenAIProjection} with no entry.
 */
export const init = (): OpenAIProjection => ({});

/**
 * Resolve the node's turn-in-progress, creating it in place the first time
 * real content needs somewhere to land. `role` and `codecMessageId` are only
 * used the first time — every caller already knows the true value at the
 * point it calls this (the output side's own role, or the wire's
 * `codec-message-id` header), so there is never a placeholder to correct later.
 * @param state - Projection to read or extend.
 * @param role - The turn's role; used only when the entry doesn't exist yet.
 * @param codecMessageId - The turn's codec-message-id; used only when the entry doesn't exist yet.
 * @returns The existing or newly-created entry.
 */
const ensureEntry = (
  state: OpenAIProjection,
  role: 'user' | 'assistant',
  codecMessageId: string,
): NonNullable<OpenAIProjection['entry']> => {
  // If an entry already exists, `role`/`codecMessageId` are ignored — even a
  // *different* codecMessageId on a later call folds into this same entry
  // rather than starting a new one. That's fine today: a Run only ever
  // produces one codec-message-id in practice, since the whole run (however
  // many /responses calls it takes) rides one continuous stream published
  // under one id (see OpenAITurn's own doc). Once something can genuinely
  // introduce more than one per Run — e.g. client-side tool calls or
  // approvals spanning separate agent invocations — this will need to decide
  // whether a new codec-message-id should start a new turn or keep extending
  // this one; nothing here makes that call yet.
  state.entry ??= { codecMessageId, message: { role, items: [] }, byItemId: new Map() };
  return state.entry;
};

const isOutputMessage = (item: Responses.ResponseOutputItem | undefined): item is Responses.ResponseOutputMessage =>
  item?.type === 'message';

const isReasoningItem = (item: Responses.ResponseOutputItem | undefined): item is Responses.ResponseReasoningItem =>
  item?.type === 'reasoning';

const isFunctionCall = (item: Responses.ResponseOutputItem | undefined): item is Responses.ResponseFunctionToolCall =>
  item?.type === 'function_call';

// The `*Part` resolvers below return the already-seeded part a delta / `.done`
// targets — the typed part at the given index on the given item, or undefined.
// Per the input contract a slot is always seeded by its opener
// (`content_part.added` / `reasoning_summary_part.added`) before any delta
// folds, so these never create a slot; they return undefined — a defensive
// no-op — only for a slot that is somehow absent or a different type. (OpenAI's
// accumulator throws there instead; we skip. See deviation 3.)
const outputTextPart = (
  item: Responses.ResponseOutputItem | undefined,
  index: number,
): Responses.ResponseOutputText | undefined => {
  if (!isOutputMessage(item)) return undefined;
  const part = item.content[index];
  return part?.type === 'output_text' ? part : undefined;
};

const refusalPart = (
  item: Responses.ResponseOutputItem | undefined,
  index: number,
): Responses.ResponseOutputRefusal | undefined => {
  if (!isOutputMessage(item)) return undefined;
  const part = item.content[index];
  return part?.type === 'refusal' ? part : undefined;
};

const reasoningTextPart = (
  item: Responses.ResponseOutputItem | undefined,
  index: number,
): Responses.ResponseReasoningItem.Content | undefined => {
  if (!isReasoningItem(item)) return undefined;
  const part = item.content?.[index];
  return part?.type === 'reasoning_text' ? part : undefined;
};

const summaryPart = (
  item: Responses.ResponseOutputItem | undefined,
  index: number,
): Responses.ResponseReasoningItem.Summary | undefined => {
  if (!isReasoningItem(item)) return undefined;
  // No part-type check: a summary slot is homogeneously `summary_text`, so only
  // absence (undefined) is possible here, not a wrong type.
  return item.summary[index];
};

/**
 * Fold one agent output event into the projection.
 * @param state - Projection to mutate.
 * @param event - The Responses stream event.
 * @param codecMessageId - The wire's codec-message-id, or undefined when the event carries none.
 */
const foldOutput = (state: OpenAIProjection, event: OpenAIOutput, codecMessageId: string | undefined): void => {
  // Without a codec-message-id there is nowhere for this event to correlate
  // to — drop, the same leniency the Vercel reducer's chunk dispatch applies.
  // In practice every real ai-output message carries one (see ReducerMeta),
  // so this never actually triggers today; it exists so the reducer stays
  // correct if that ever stops being true.
  if (codecMessageId === undefined) return;
  const entry = ensureEntry(state, 'assistant', codecMessageId);
  switch (event.type) {
    case 'response.output_item.added': {
      // Push only item types the codec models; skip any others. Skipping (rather
      // than throwing) keeps an older subscriber tolerant of item types a newer
      // agent may emit — the same leniency the decoder applies to unknown event
      // kinds. The encoder rejects unmodelled item types at publish (see
      // `assertModelledOutputItem`), so on a well-formed stream this never skips;
      // it is the forward-compatibility net, and the narrowing that lets a stored
      // item be a valid `ResponseInputItem`. Guard before cloning so a skipped
      // item is not deep-cloned only to be discarded.
      if (!isModelledOutputItem(event.item)) return;
      // Find-or-create by item id (as the Vercel reducer's `ensureMessage`
      // does). The mid-stream-join repair in `decode-lifecycle.ts` synthesises
      // an owner `output_item.added` unconditionally, so one id can be added
      // more than once: alongside the real add (a client present at the start,
      // or history paging it in — in either serial order), and once per sibling
      // part stream on one message (an `output_text` and a `refusal`). The added
      // envelope carries nothing beyond the id, type and role/status (parts and
      // a reasoning item's encrypted_content arrive on later events), so an
      // existing owner already holds everything a second add would; keeping the
      // first collapses every redundant add to the one item.
      const id = event.item.id;
      if (id !== undefined && entry.byItemId.has(id)) return;
      const item = structuredClone(event.item);
      entry.message.items.push(item);
      if (id !== undefined) entry.byItemId.set(id, item);
      return;
    }
    case 'response.output_item.done': {
      // The done envelope is wire-slimmed to { id, type, status } (plus a
      // message's per-part logprobs and a reasoning item's encrypted_content):
      // the item's content is already folded from the streams, so finalise the
      // existing owner's terminal status in place rather than replacing it. A
      // `done` with no seeded owner has nothing to finalise: the discrete `added`
      // is a persisted channel message ordered before `done`, so hydration seeds
      // the owner first — and a reasoning item's encrypted_content also rides
      // `added`, so even a dropped orphan `done` cannot lose it.
      const done = event.item;
      if (done.id === undefined) return;
      const existing = entry.byItemId.get(done.id);
      if (existing === undefined) return;
      // `done` is `DoneItem` — SlimDoneItem-shaped for the three modelled
      // types (only ever the case in practice, since the decoder never
      // reconstructs anything else), full-shaped for any other real item
      // type — so its `type` is checked directly: SlimDoneItem is itself
      // discriminated by `type`, so this narrows `done.status` (and, for a
      // message, `done.content`; for reasoning, `done.encrypted_content`)
      // precisely — no cast needed.
      if (isOutputMessage(existing) && done.type === 'message') {
        existing.status = done.status;
        // Fold each output_text part's logprobs (the one content datum not
        // carried by the streamed deltas — see slimDoneItem) into the matching,
        // already-streamed content slot, by index. `logprobs` keeps its rich
        // `ResponseOutputText` type through the slim, so this assigns without a
        // cast. Absent when logprobs weren't requested (the slim omits `content`).
        for (const [index, part] of (done.content ?? []).entries()) {
          const slot = existing.content[index];
          if (part.type === 'output_text' && part.logprobs !== undefined && slot?.type === 'output_text') {
            slot.logprobs = part.logprobs;
          }
        }
      } else if (isFunctionCall(existing) && done.type === 'function_call') {
        existing.status = done.status;
      } else if (isReasoningItem(existing) && done.type === 'reasoning') {
        existing.status = done.status;
        // encrypted_content is done-only (never streamed) — set it here so the
        // stateless (store:false / ZDR) round-trip preserves the chain-of-thought.
        if (typeof done.encrypted_content === 'string') existing.encrypted_content = done.encrypted_content;
      }
      return;
    }
    case 'response.content_part.added': {
      const item = entry.byItemId.get(event.item_id);
      const part = event.part;
      // Opener: seed the slot at content_index with the added part (text/refusal
      // on a message, reasoning-text on a reasoning item). Positional, so an
      // absent earlier-index stream leaves a transient hole (see the input
      // contract) that `getMessages` compacts on exit. The delta/`.done` arms
      // below only mutate this seeded slot.
      if (isOutputMessage(item) && (part.type === 'output_text' || part.type === 'refusal')) {
        item.content[event.content_index] = structuredClone(part);
      } else if (isReasoningItem(item) && part.type === 'reasoning_text') {
        (item.content ??= [])[event.content_index] = structuredClone(part);
      }
      return;
    }
    case 'response.output_text.delta': {
      const part = outputTextPart(entry.byItemId.get(event.item_id), event.content_index);
      if (part) part.text += event.delta;
      return;
    }
    case 'response.output_text.done': {
      const part = outputTextPart(entry.byItemId.get(event.item_id), event.content_index);
      if (part) part.text = event.text;
      return;
    }
    case 'response.refusal.delta': {
      const part = refusalPart(entry.byItemId.get(event.item_id), event.content_index);
      if (part) part.refusal += event.delta;
      return;
    }
    case 'response.refusal.done': {
      const part = refusalPart(entry.byItemId.get(event.item_id), event.content_index);
      if (part) part.refusal = event.refusal;
      return;
    }
    case 'response.reasoning_text.delta': {
      const part = reasoningTextPart(entry.byItemId.get(event.item_id), event.content_index);
      if (part) part.text += event.delta;
      return;
    }
    case 'response.reasoning_text.done': {
      const part = reasoningTextPart(entry.byItemId.get(event.item_id), event.content_index);
      if (part) part.text = event.text;
      return;
    }
    case 'response.reasoning_summary_part.added': {
      const item = entry.byItemId.get(event.item_id);
      // Opener: seed the summary slot at summary_index (positional, like
      // content_part.added above — a gap leaves a transient hole, compacted at getMessages).
      if (isReasoningItem(item)) item.summary[event.summary_index] = { type: 'summary_text', text: event.part.text };
      return;
    }
    case 'response.reasoning_summary_text.delta': {
      const part = summaryPart(entry.byItemId.get(event.item_id), event.summary_index);
      if (part) part.text += event.delta;
      return;
    }
    case 'response.reasoning_summary_text.done': {
      const part = summaryPart(entry.byItemId.get(event.item_id), event.summary_index);
      if (part) part.text = event.text;
      return;
    }
    case 'response.function_call_arguments.delta': {
      const item = entry.byItemId.get(event.item_id);
      if (isFunctionCall(item)) item.arguments += event.delta;
      return;
    }
    case 'response.function_call_arguments.done': {
      const item = entry.byItemId.get(event.item_id);
      // The complete streamed arguments. (output_item.done is slimmed to
      // { id, type, status } and no longer re-carries them — see its arm above.)
      if (isFunctionCall(item)) item.arguments = event.arguments;
      return;
    }
    case 'function_call_output': {
      // The server-executed tool's result. Append it to the turn so it sits
      // beside its function_call (paired by call_id when rendered and when fed
      // back to /responses). Function calls themselves fold via the
      // output_item arms above — a function_call is a ResponseOutputItem.
      entry.message.items.push(structuredClone(event.item));
      return;
    }
    default: {
      // Everything else folds to nothing, for the two reasons the top-of-file
      // comment sets out. First, never needed to build the projection, so
      // dropped at encode and never on the wire: the response-lifecycle events
      // (terminal completed / incomplete / failed and the openers), the
      // stream-level `error`, and the content-/summary-part close boundaries.
      // Run outcome — including failure — is observed out-of-band via the
      // transport run-end event, never folded into items. Second, not modelled
      // yet, so folded to nothing for graceful forward-compat if a newer agent
      // emits it: the remaining event types (hosted tools / modalities, AIT-1121).
      // TODO(AIT-1113): an agent-side run-outcome mapper will read response.failed
      // / `error` from the raw stream (before encode) to set the run-end reason.
      return;
    }
  }
};

/**
 * Whether an item is an input message (the shape a user turn carries). Within
 * the user-message fold every item is an input message the codec constructed,
 * so the narrowing to {@link Responses.ResponseInputItem.Message} is sound here
 * even though an output message would also satisfy `type === 'message'`.
 * @param item - The item to test.
 * @returns Whether to treat `item` as an input message.
 */
const isInputMessage = (item: OpenAIItem): item is Responses.ResponseInputItem.Message =>
  item.type === 'message' && Array.isArray(item.content);

/**
 * Fold a user-message turn into the projection. The input wire delivers one
 * event per content part, so each fold merges its part(s) into the turn's
 * single input message — appending to the existing message item if present,
 * else seeding it. This keeps the optimistic (whole-message) fold and the
 * per-part wire refold converging on the same turn.
 * @param state - Projection to mutate.
 * @param turn - The user turn (one input message, one or more content parts).
 * @param codecMessageId - The wire's codec-message-id, or undefined when the event carries none.
 */
const foldUserMessage = (state: OpenAIProjection, turn: OpenAITurn, codecMessageId: string | undefined): void => {
  // Without a codec-message-id there is nowhere for a fresh entry to land —
  // drop, the same leniency the output side applies (see foldOutput above).
  if (codecMessageId === undefined) return;
  const entry = ensureEntry(state, turn.role, codecMessageId);
  // Use the turn's own role (carried on the wire role header) rather than
  // forcing 'user', so the role round-trips faithfully; also keeps it current
  // if a later fold's role somehow differs. For the user-message input it is
  // 'user' in practice.
  entry.message.role = turn.role;
  // Assumption in use here: a user turn is a single input message, so every
  // incoming part merges into the one message item — resolved once, seeded on
  // first contact, appended thereafter.
  let target = entry.message.items.find(isInputMessage);
  for (const incoming of turn.items) {
    if (!isInputMessage(incoming)) continue;
    if (target) {
      target.content.push(...incoming.content);
    } else {
      target = structuredClone(incoming);
      entry.message.items.push(target);
    }
  }
};

/**
 * Fold one direction-tagged input or output event into the projection.
 * @param state - Projection to fold into (mutated in place and returned).
 * @param event - The direction-tagged input or output event.
 * @param meta - Transport-derived metadata (serial, optional codec-message-id).
 * @returns The same projection reference.
 */
export const fold = (
  state: OpenAIProjection,
  event: CodecEvent<OpenAIInput, OpenAIOutput>,
  meta: ReducerMeta,
): OpenAIProjection => {
  if (event.direction === 'output') {
    foldOutput(state, event.event, meta.messageId);
  } else if (event.event.kind === 'user-message') {
    foldUserMessage(state, event.event.message, meta.messageId);
  }
  // The only other input variant is `regenerate` — a wire-only signal that
  // decodes to nothing and so never reaches the reducer; it carries no
  // projection state. Tool results and approvals (with their own dispatch)
  // arrive in later increments.
  return state;
};

/**
 * The dense (hole-free) prefix of a positionally-slotted array: the contiguous
 * run of present slots from index 0, stopping at the first hole. This is the
 * largest prefix safe to expose for positional data, whatever the hole shape: a
 * present slot above a hole can't be surfaced without either re-introducing the
 * gap or showing the part at the wrong index (then reordering when the gap
 * fills), so it is correctly held back until the gap is filled. The compaction
 * therefore assumes nothing about where holes sit — the leading-hole shape a
 * partial load actually produces (see {@link getMessages}) is not a correctness
 * precondition, it only makes the exposed prefix all-or-nothing (empty until
 * index 0 lands, then the whole array) rather than growing a slot at a time.
 * Returns the same reference when the array is already dense, so a hole-free
 * item is not copied.
 * @param slots - The positional array (a message's `content`, or a reasoning
 *   item's `content` / `summary`).
 * @returns The dense prefix — `slots` itself when already dense.
 */
const densePrefix = <T>(slots: T[]): T[] => {
  let end = 0;
  while (end < slots.length && slots[end] !== undefined) end++;
  return end === slots.length ? slots : slots.slice(0, end);
};

/**
 * Compact an item's positionally-slotted arrays to their {@link densePrefix},
 * returning a new item only when a hole was actually trimmed (else the same
 * reference). Only an assistant message's `content` and a reasoning item's
 * `content` / `summary` are positional and can hole; a function call's
 * `arguments` is a string, and a user input message's content is append-built,
 * so both pass through untouched.
 * @param item - The turn item to compact.
 * @returns The item with dense positional arrays.
 */
const compactItem = (item: OpenAIItem): OpenAIItem => {
  if (item.type === 'reasoning') {
    const summary = densePrefix(item.summary);
    const content = item.content === undefined ? item.content : densePrefix(item.content);
    if (summary === item.summary && content === item.content) return item;
    return { ...item, summary, content };
  }
  // An output message (identified by its required `id`) slots content
  // positionally; a user input message has no `id` and appends its content, so
  // it never holes.
  if (item.type === 'message' && 'id' in item) {
    const content = densePrefix(item.content);
    return content === item.content ? item : { ...item, content };
  }
  return item;
};

/**
 * Extract the turn for this projection, paired with its codec-message-id.
 * @param projection - A projection produced by `init` + repeated `fold`.
 * @returns A single-element list (the turn), or empty when nothing has folded.
 */
export const getMessages = (projection: OpenAIProjection): CodecMessage<OpenAITurn>[] => {
  const { entry } = projection;
  // `entry` can exist with no items yet: it's created as soon as a
  // codec-message-id is known, before foldOutput decides whether the
  // triggering event actually adds anything (e.g. an output_item.added for a
  // hosted-tool item type this codec doesn't model yet — AIT-1121 — folds to
  // nothing). Filtering here, rather than deferring entry creation per arm,
  // keeps foldOutput from having to special-case which events are allowed to
  // create the entry and which aren't.
  if (entry === undefined || entry.message.items.length === 0) return [];
  // Compact any transient positional holes at the read boundary: a
  // partially-loaded run can carry a leading hole in a message's `content` or a
  // reasoning item's `content` / `summary` until its earlier-index wires page
  // in. Truncating to the dense-from-0 prefix here means a consumer only ever
  // sees a dense array — never an unannounced `undefined` from a sparse slot —
  // while the internal projection keeps the hole (the per-node WireLog
  // re-densifies it once the missing events fold). Hole-free items pass through
  // by reference (compactItem/densePrefix don't re-clone them); only holed
  // items, and the thin turn wrapper, are freshly allocated.
  //
  // Why truncate rather than gap-fill the missing earlier slots: we can't
  // generically fabricate a slot we've not yet seen, because a message's
  // content part is `output_text` *or* `refusal` and the absent part's type is
  // unknown until its own stream folds — any placeholder would be wrong-typed
  // and invented. (Even the homogeneous arrays — reasoning `content` /
  // `summary` — would only yield a fake empty part, so they aren't special-cased.)
  //
  // Consequence: to see the newer parts of a history-straddling run the user
  // must page back past its earlier-index boundary — until content_index=0
  // lands the item renders with empty content (as a freshly-added item does).
  // TODO(AIT-1160): this compaction is codec-local; rethink the long-term way
  // positional codecs should handle partially-loaded runs (e.g. a transport
  // completeness gate) rather than each repeating it.
  //
  // No memoisation needed: the View already memoises `getMessages` per node
  // (see `conversation-projection.ts`) and invalidates it on fold, so this runs
  // once per change, not once per flatten. Caching the compacted result on the
  // projection would only pay off if profiling later showed this hot
  // independently of that; not worth it now.
  const items = entry.message.items.map((item) => compactItem(item));
  return [{ codecMessageId: entry.codecMessageId, message: { ...entry.message, items } }];
};
