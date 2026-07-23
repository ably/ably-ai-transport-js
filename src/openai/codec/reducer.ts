/**
 * OpenAI Responses reducer.
 *
 * Assembled from the shared spine ({@link defineReducer}): the spine owns the
 * entry store, the direction/drop dispatch, the well-known `user-message` /
 * `regenerate` routing, and `getMessages`; this module supplies the
 * OpenAI-specific fold bodies. A single run can produce several messages: the
 * spine keys them by codec-message-id, find-or-create per id, so `getMessages`
 * returns one {@link OpenAIMessage} per distinct codec-message-id seen in the
 * node.
 *
 * The per-entry tracker is a `Map<itemId, ResponseOutputItem>` — the reducer's
 * own item index, mapping an output item's id to the live (mutable) item in
 * `message.items` for delta accumulation. The spine holds it alongside each
 * message and hands both back through `ctx.lookup` / `ctx.ensure`.
 *
 * Message boundary. A message is defined entirely by its codec-message-id — the
 * transport mints one per `pipe`/`send` call. Every event routes to the message
 * its `meta.messageId` names; a fresh id starts a fresh message. Nothing in the
 * reducer references OpenAI `/responses` calls: how the agent chunks its work
 * into `pipe`/`send` calls is the agent's choice, and that choice alone decides
 * message boundaries.
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
 * 1. Keys items on `item_id` rather than the positional `output_index`, because
 *    `item_id` is unique and stable across re-adds, so it survives the
 *    idempotent opening-bracket add (deviation 4) and any late-join
 *    re-synthesis, where a positional index would collide or shift.
 * 2. Folds a subsequence rather than the whole stream from `response.created`.
 *    OpenAI bootstraps only from `response.created`; we may join late or replay
 *    a history suffix.
 * 3. Skips an unseen slot/item where OpenAI throws ("missing output/content at
 *    index N"). This leniency is what lets a positional hole exist internally at
 *    all (compacted at `getMessages`), where OpenAI never holes because it
 *    throws first.
 * 4. Does an idempotent opening-bracket add (find-or-create) rather than a
 *    `push`, because `decode-lifecycle.ts` can re-synthesise an
 *    `output_item.added` for a late joiner, so an id may be added more than
 *    once; we keep the first.
 * 5. `output_item.done` finalises `status` in place rather than cloning the
 *    whole finalised item. Our done is wire-form (content already folded from
 *    the streams), so it applies only `status`, a message's per-part
 *    `logprobs`, and a reasoning item's `encrypted_content`.
 * 6. Response-lifecycle and stream-`error` events fold to nothing, where OpenAI
 *    folds them into the `Response` snapshot; we observe run outcome
 *    out-of-band (the transport run-end event; AIT-1113 will map it from the
 *    raw stream).
 * 7. Adds `function_call_output` — no Responses-stream equivalent (OpenAI
 *    surfaces tool output only as next-turn input); we append it to the message
 *    its codec-message-id names. Because each `pipe`/`send` mints a fresh id, an
 *    output published on its own `send` lands in its own message, separate from
 *    the one holding the `function_call`; a renderer pairs them by `call_id`.
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

import { defineReducer, type ReducerCtx, type ReducerProjection } from '../../core/codec/index.js';
import type { OpenAIInput, OpenAIItem, OpenAIMessage, OpenAIOutput } from './events.js';
import { isModelledOutputItem } from './events.js';

/**
 * The reducer's per-entry item index: an output item's id mapped to the live
 * (mutable) item in `message.items`, for delta accumulation. The spine holds
 * one per message, keyed by codec-message-id, and hands it back as
 * `entry.tracker` from `ctx.lookup` / `ctx.ensure`.
 */
type OpenAITrackers = Map<string, Responses.ResponseOutputItem>;

/**
 * Per-node projection: the node's messages-in-progress, keyed by
 * codec-message-id, each carrying the reducer's item index as its tracker.
 * `getMessages` compacts each message's transient positional holes on the way
 * out (see the {@link defineReducer} `toMessage` transform below).
 */
export type OpenAIProjection = ReducerProjection<OpenAIMessage, OpenAITrackers, undefined>;

/** The fold-body capability object for the OpenAI reducer. */
type OpenAICtx = ReducerCtx<OpenAIMessage, OpenAITrackers, undefined, 'user' | 'assistant'>;

/**
 * Resolve an item within the current event's message, or undefined. The item
 * lives in the message its own event's codec-message-id names, because every
 * event on one `pipe`/`send` shares that id (see the message-boundary note).
 * The delta / `.done` arms use this to find the seeded item to mutate.
 * @param ctx - The fold-body capability object.
 * @param itemId - The output item's id.
 * @returns The live item, or undefined when the message or item is unseen.
 */
const resolveItem = (ctx: OpenAICtx, itemId: string): Responses.ResponseOutputItem | undefined =>
  ctx.lookup()?.tracker.get(itemId);

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
  // No part-type check: a summary slot is homogeneously `summary_text`, so the
  // only thing that can go wrong here is absence (undefined), never a wrong type.
  return item.summary[index];
};

/**
 * Fold one agent output event into the projection via `ctx`.
 * @param ctx - The fold-body capability object.
 * @param event - The Responses stream event.
 */
const foldOutput = (ctx: OpenAICtx, event: OpenAIOutput): void => {
  switch (event.type) {
    case 'response.output_item.added': {
      // Push only item types the codec models; skip any others. Skipping (rather
      // than throwing) keeps an older subscriber tolerant of item types a newer
      // agent may emit — the same leniency the decoder applies to unknown event
      // kinds. The encoder rejects unmodelled item types at publish (see
      // `assertModelledOutputItem`), so on a well-formed stream this never skips;
      // it is the forward-compatibility net, and the narrowing that lets a stored
      // item be a valid `ResponseInputItem`. Guard before creating the message so
      // a skipped item leaves no empty message behind (lazy creation).
      if (!isModelledOutputItem(event.item)) return;
      const entry = ctx.ensure('assistant');
      // Find-or-create by item id. The mid-stream-join repair in
      // `decode-lifecycle.ts` synthesises an opening-bracket `output_item.added`
      // unconditionally, so one id can be added more than once: alongside the
      // real add (a client present at the start, or history paging it in — in
      // either serial order), and once per sibling part stream on one message (an
      // `output_text` and a `refusal`). The added envelope carries nothing beyond
      // the id, type and role/status (parts and a reasoning item's
      // encrypted_content arrive on later events), so an existing item already
      // holds everything a second add would; keeping the first collapses every
      // redundant add to the one item.
      const id = event.item.id;
      if (id !== undefined && entry.tracker.has(id)) return;
      const item = structuredClone(event.item);
      entry.message.items.push(item);
      if (id !== undefined) entry.tracker.set(id, item);
      return;
    }
    case 'response.output_item.done': {
      // The done envelope is wire-form { id, type, status } (plus a
      // message's per-part logprobs and a reasoning item's encrypted_content):
      // the item's content is already folded from the streams, so finalise the
      // existing item's terminal status in place rather than replacing it. A
      // `done` with no seeded item has nothing to finalise: the discrete `added`
      // is a persisted channel message ordered before `done`, so hydration seeds
      // the item first — and a reasoning item's encrypted_content also rides
      // `added`, so even a dropped orphan `done` cannot lose it.
      const done = event.item;
      if (done.id === undefined) return;
      const existing = resolveItem(ctx, done.id);
      if (existing === undefined) return;
      // `done` is `DoneItem`: WireDoneItem-shaped for the three modelled
      // types (only ever the case in practice, since the decoder never
      // reconstructs anything else) and full-shaped for any other real item
      // type, so its `type` is checked directly. WireDoneItem is itself
      // discriminated by `type`, so this narrows `done.status` (and, for a
      // message, `done.content`; for reasoning, `done.encrypted_content`)
      // precisely, with no cast needed.
      if (isOutputMessage(existing) && done.type === 'message') {
        existing.status = done.status;
        // Fold each output_text part's logprobs (the one content datum not
        // carried by the streamed deltas — see toWireItem) into the matching,
        // already-streamed content slot, by index. `logprobs` keeps its rich
        // `ResponseOutputText` type through the wire form, so this assigns without a
        // cast. Absent when logprobs weren't requested (the wire form omits `content`).
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
      const item = resolveItem(ctx, event.item_id);
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
      const part = outputTextPart(resolveItem(ctx, event.item_id), event.content_index);
      if (part) part.text += event.delta;
      return;
    }
    case 'response.output_text.done': {
      const part = outputTextPart(resolveItem(ctx, event.item_id), event.content_index);
      if (part) part.text = event.text;
      return;
    }
    case 'response.refusal.delta': {
      const part = refusalPart(resolveItem(ctx, event.item_id), event.content_index);
      if (part) part.refusal += event.delta;
      return;
    }
    case 'response.refusal.done': {
      const part = refusalPart(resolveItem(ctx, event.item_id), event.content_index);
      if (part) part.refusal = event.refusal;
      return;
    }
    case 'response.reasoning_text.delta': {
      const part = reasoningTextPart(resolveItem(ctx, event.item_id), event.content_index);
      if (part) part.text += event.delta;
      return;
    }
    case 'response.reasoning_text.done': {
      const part = reasoningTextPart(resolveItem(ctx, event.item_id), event.content_index);
      if (part) part.text = event.text;
      return;
    }
    case 'response.reasoning_summary_part.added': {
      const item = resolveItem(ctx, event.item_id);
      // Opener: seed the summary slot at summary_index (positional, like
      // content_part.added above — a gap leaves a transient hole, compacted at getMessages).
      if (isReasoningItem(item)) item.summary[event.summary_index] = { type: 'summary_text', text: event.part.text };
      return;
    }
    case 'response.reasoning_summary_text.delta': {
      const part = summaryPart(resolveItem(ctx, event.item_id), event.summary_index);
      if (part) part.text += event.delta;
      return;
    }
    case 'response.reasoning_summary_text.done': {
      const part = summaryPart(resolveItem(ctx, event.item_id), event.summary_index);
      if (part) part.text = event.text;
      return;
    }
    case 'response.function_call_arguments.delta': {
      const item = resolveItem(ctx, event.item_id);
      if (isFunctionCall(item)) item.arguments += event.delta;
      return;
    }
    case 'response.function_call_arguments.done': {
      const item = resolveItem(ctx, event.item_id);
      // The complete streamed arguments. (output_item.done is reduced to
      // { id, type, status } and no longer re-carries them — see its arm above.)
      if (isFunctionCall(item)) item.arguments = event.arguments;
      return;
    }
    case 'function_call_output': {
      // The server-executed tool's result. Fold it into the message its own
      // codec-message-id names (rule B): every event routes by codec-message-id,
      // with no `call_id` scan. Because each `pipe`/`send` mints a fresh id, an
      // output published on its own `send` lands in its own message, separate
      // from the one holding the `function_call`; a renderer pairs them by
      // `call_id`. This is a deliberate divergence from the Vercel reducer,
      // which scans by `toolCallId` to reunite output with its call in one
      // message; OpenAI keeps the reducer uniform instead. Function calls
      // themselves fold via the output_item arms above — a function_call is a
      // ResponseOutputItem.
      const entry = ctx.ensure('assistant');
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
 * Whether an item is an input message (the shape a user message carries).
 * Within the user-message fold every item is an input message the codec
 * constructed, so the narrowing to {@link Responses.ResponseInputItem.Message}
 * is sound here even though an output message would also satisfy `type ===
 * 'message'`.
 * @param item - The item to test.
 * @returns Whether to treat `item` as an input message.
 */
const isInputMessage = (item: OpenAIItem): item is Responses.ResponseInputItem.Message =>
  item.type === 'message' && Array.isArray(item.content);

/**
 * Fold a user message into the projection. The input wire delivers one event
 * per content part, so each fold merges its part(s) into the message's single
 * input message item — appending to the existing item if present, else seeding
 * it. This keeps the optimistic (whole-message) fold and the per-part wire
 * refold converging on the same message.
 * @param ctx - The fold-body capability object.
 * @param userMessage - The user message (one input message item, one or more content parts).
 */
const foldUserMessage = (ctx: OpenAICtx, userMessage: OpenAIMessage): void => {
  const entry = ctx.ensure(userMessage.role);
  // Use the message's own role (carried on the wire role header) rather than
  // forcing 'user', so the role round-trips faithfully; also keeps it current
  // if a later fold's role somehow differs. For the user-message input it is
  // 'user' in practice.
  entry.message.role = userMessage.role;
  // Assumption in use here: a user message is a single input message item, so
  // every incoming part merges into the one item — resolved once, seeded on
  // first contact, appended thereafter.
  let target = entry.message.items.find(isInputMessage);
  for (const incoming of userMessage.items) {
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
 * @param item - The message item to compact.
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
 * Compact a stored message's transient positional holes at the read boundary.
 *
 * A partially-loaded run can carry a leading hole in a message's `content` or a
 * reasoning item's `content` / `summary` until its earlier-index wires page in.
 * Truncating to the dense-from-0 prefix here means a consumer only ever sees a
 * dense array — never an unannounced `undefined` from a sparse slot — while the
 * internal projection keeps the hole (the per-node WireLog re-densifies it once
 * the missing events fold). Hole-free items pass through by reference
 * (compactItem/densePrefix don't re-clone them); only holed items, and the thin
 * message wrapper, are freshly allocated.
 *
 * Why truncate rather than gap-fill the missing earlier slots: we can't
 * generically fabricate a slot we've not yet seen, because a message's content
 * part is `output_text` *or* `refusal` and the absent part's type is unknown
 * until its own stream folds — any placeholder would be wrong-typed and
 * invented. (Even the homogeneous arrays — reasoning `content` / `summary` —
 * would only yield a fake empty part, so they aren't special-cased.)
 *
 * Consequence: to see the newer parts of a history-straddling run the user must
 * page back past its earlier-index boundary — until content_index=0 lands the
 * item renders with empty content (as a freshly-added item does).
 * TODO(AIT-1160): this compaction is codec-local; rethink the long-term way
 * positional codecs should handle partially-loaded runs (e.g. a transport
 * completeness gate) rather than each repeating it.
 *
 * No memoisation needed: the View already memoises `getMessages` per node (see
 * `conversation-projection.ts`) and invalidates it on fold, so this runs once
 * per change, not once per flatten. Caching the compacted result on the
 * projection would only pay off if profiling later showed this hot
 * independently of that; not worth it now.
 * @param message - The stored message.
 * @returns The message with dense positional arrays.
 */
const compactMessage = (message: OpenAIMessage): OpenAIMessage => ({
  ...message,
  items: message.items.map((item) => compactItem(item)),
});

const reducer = defineReducer<OpenAIInput, OpenAIOutput, OpenAIMessage, OpenAITrackers, 'user' | 'assistant'>({
  createEntry: (role) => ({ message: { role, items: [] }, tracker: new Map() }),
  foldOutput: (ctx, event) => {
    foldOutput(ctx, event);
  },
  foldUserMessage: (ctx, message) => {
    foldUserMessage(ctx, message);
  },
  toMessage: (message) => compactMessage(message),
});

/** The OpenAI reducer's `init`: a fresh empty projection. */
export const init = reducer.init;
/** The OpenAI reducer's `fold`: folds one input/output event into the projection. */
export const fold = reducer.fold;
/** The OpenAI reducer's `getMessages`: one compacted message per codec-message-id. */
export const getMessages = reducer.getMessages;
