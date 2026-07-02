# OpenAI codec streaming — API-design brief

_Agent-facing handoff for the **API-design phase** of the streaming-model work.
This is the "how" companion to the "why"/target docs. It is intentionally terse
and points you at the authoritative sources rather than restating them._

## What this phase is

Design the **`stream()` / output-descriptor API changes** needed to let the codec
stream every incremental family OpenAI emits. The behaviour target is **agreed**;
your job is the **surface** — not to re-litigate the goal.

Do **not** start writing the codec families yet. Produce a design for the core
API changes (the three capabilities below), get it reviewed, then implement.

## Read first

1. `notes/openai-codec-build-log.md` — master doc; see the **"Scope update"**
   section for why this is now a core codec-interface question.
2. `notes/lawrence-questions/streaming-target-model.html` — **the agreed target**
   (five families, the slot model, the slot-reveal start policy, the three
   capabilities, the family×capability matrix, the fn-args asymmetry). This is the
   spec for what you're enabling.

Then read the actual core code (see "Code map") and design against the real types.
The other `notes/lawrence-questions/*.html` docs are optional background — the
source is authoritative.

## The goal (the bar)

**Stream everything OpenAI streams. If a family can't be streamed, the `stream()`
model is too narrow and must change** — "carry the final value only" is not an
acceptable resting state for anything OpenAI delivers incrementally.

Concretely, five families must become real `stream(...)` families (they're
`ignore`d today): `output_text` (already streams, but only single-part — must
gain per-part targeting), `refusal`, `reasoning_summary_text`, `reasoning_text`,
`function_call_arguments`. Naming rule: **family id = the stem its `.delta`/`.done`
share** (`response.` dropped) → `output_text`, `refusal`, `reasoning_summary_text`,
`reasoning_text`, `function_call_arguments`. This renames today's `'text'` →
`output_text`.

## The three capabilities to design (all in `src/core/codec`, all generic)

These are **core, codec-agnostic** changes to the shared stream/descriptor model —
the OpenAI codec only *consumes* them via new descriptors. Design each generically
(e.g. Cap 1 is a general `(chunk) => string`, not "read `item.id`"); the OpenAI
layer supplies the OpenAI-specific bits. **Whatever you change must not break the
Vercel codec** (the other `stream()` consumer) — either keep the API
backward-compatible or update Vercel too.

### Cap 1 — derived stream id (the transport's uniqueness handle)

- **Today:** `OutputStreamSpec.idField` is `StringKeyOf<Start> & StringKeyOf<Delta>
  & StringKeyOf<End>` — one top-level **string property name**, present on all
  three phases. The encoder reads the id as `prop(chunk, idField)`
  (`output-descriptor-encoder.ts`); it becomes the Ably `stream-id` header
  (`encoder.ts` `startStream`).
- **Want:** the id **computed from the chunk**. Two sub-needs, hit by disjoint
  families:
  - **compose** — combine >1 field (no single one is unique): `item_id +
    content_index` (text/refusal/reasoning_text), `item_id + summary_index`
    (summary).
  - **relocate** — read from a different place per phase (same id, different
    location): fn args carry it nested at `item.id` on the start, top-level
    `item_id` on the deltas.
- **Design question:** how does a family declare this? An extractor `(chunk) =>
  string` (possibly per-phase)? The id stays an **opaque uniqueness token** — the
  reducer must never parse it (see Cap 2).

### Cap 2 — decoded deltas carry their real fields (the reducer's routing)

- **Today:** `buildDelta` (`output-descriptor-decoder.ts`) emits exactly
  `{ [idField]: tracker.streamId, [deltaField]: delta }`. So the delta's `item_id`
  is *the stream id echoed back* — which only works because today stream id ==
  `item_id`. The position index is dropped, so the reducer appends to "the trailing
  part" (`reducer.ts` `trailingOutputText`).
- **Want:** the decoder builds `{ item_id, content_index, delta }` (the fields the
  *real* delta carries) so the reducer targets the exact slot. The values are
  already on the wire — the start's fields are re-stamped on every append
  (`encoder.ts` `appendStream` repeats `persistentCodec`); the decoder just
  discards them on the delta path today.
- **Cap 1 forces Cap 2:** once the stream id is composite (`msg_1:0`) it can't be
  echoed as `item_id` (it'd corrupt it). So `item_id` must be reconstructed from a
  **real re-stamped field**, and the composite id stays transport-only.
- **Design questions:** how does a family declare the delta's **own** field set
  (it differs from the start's — e.g. `content_part.added` carries `part`, but the
  real `output_text.delta` does **not**)? Does `item_id` become a declared field
  (currently it's only the id/stream-id, not a codec `field`)? A `decodeDelta`
  hook, or a declarative `deltaFields`?

### Cap 3 — slot-reveal / discriminated start

- **Today:** the encoder routes a chunk to a stream phase by `type` alone
  (`streamByPhase.get(chunk.type)` in `output-descriptor-encoder.ts`). start/delta/
  end must be three **distinct** types (aliasing start==delta collides in the map,
  and `startStream` never fires).
- **Want:** the policy **"a stream starts on the event that first reveals its
  slot."** That reveal event is sometimes **shared**, so the start is resolved by a
  **payload discriminator**, not just `type`:
  - `content_part.added` → text / refusal / reasoning_text, by `part.type`;
  - `output_item.added` → the fn-args stream **only** when `item.type ===
    'function_call'` (a message/reasoning `output_item.added` is not a stream start
    — the stream declines and the existing `event('response.output_item.added')`
    descriptor handles it; `stream()` itself never publishes a discrete message).
- **Fn-args asymmetry (see target doc §3):** a `function_call` has no sub-array of
  parts, so no `*_part.added` event — its slot (the item's own `arguments`) is born
  with the item, so its reveal/start is `output_item.added` (nested id → also why
  it needs Cap 1 "relocate").
- **Design questions:** how does a start declare its discriminator + the
  decline→`event()` fallthrough? **Open alternative to weigh:** a *broader* core
  mode — a stream with **no** start event, opened lazily on its first (dedicated)
  delta — would drop discrimination entirely. We lean **against** it (every family
  has a real reveal event that carries the slot's part/item + index, a richer
  start, and it matches what a start-lead-in repair would synthesise), but it's a
  legitimate option to consider and reject explicitly.

## Where each family lands (Cap requirements)

| family | Cap 1 | Cap 2 | Cap 3 |
| --- | --- | --- | --- |
| `reasoning_summary_text` | ✅ compose | ✅ | — (dedicated start) |
| `output_text` | ✅ compose | ✅ | ✅ (shared `content_part.added`) |
| `refusal` | ✅ compose | ✅ | ✅ |
| `reasoning_text` | ✅ compose | ✅ | ✅ |
| `function_call_arguments` | ✅ relocate | — (item-level, no sub-index) | ✅ (`output_item.added`; non-fc → `event()`) |

**Suggested order:** `reasoning_summary_text` first — it needs only Cap 1
(compose) + Cap 2, no discriminated start, so it proves the id + delta-fields
changes end-to-end on the simplest case. Then the `content_part.added` families
(adds Cap 3 discrimination among stream families). Then `function_call_arguments`
last — the hardest (Cap 1 relocate + Cap 3 on a shared start with a
decline-to-`event()` path).

## Code map (grounding)

- `src/core/codec/output-descriptors.ts` — `OutputStreamSpec`, `StringKeyOf`,
  `ResolveType`, the `stream`/`event`/`ignore` builder. **Cap 1 + Cap 3 land in the
  spec + builder here.**
- `src/core/codec/output-descriptor-encoder.ts` — `streamByPhase` dispatch,
  `prop(chunk, idField)`, start/append/close routing, discrete fallthrough. **Cap 1
  (id extraction) + Cap 3 (discriminated dispatch).**
- `src/core/codec/output-descriptor-decoder.ts` — `buildStart`/`buildDelta`/
  `buildEnd`. **Cap 2 (delta field reconstruction).**
- `src/core/codec/decoder.ts` — `DecoderCore`, action→hook dispatch, the stream
  tracker, `streamId` from `HEADER_STREAM_ID`.
- `src/core/codec/encoder.ts` — `startStream`/`appendStream`/`closeStream`, the
  `stream-id` header, `persistentCodec` re-stamped on every append.
- `src/core/codec/field-bag.ts` / `fields.ts` — `writeFields`/`readFields`,
  `HeaderField`, `FieldFor`, `StringKeyOf`.
- `src/openai/codec/descriptors.ts` — the OpenAI `stream('text', …)` family + the
  `ignore(...)` set to be replaced; `reducer.ts` (`trailingOutputText`, `byItemId`).
- `src/vercel/codec/` — the other `stream()` consumer; **don't break it.**

## Out of scope for this phase (do not entangle)

- **`decodeLifecycle`** — out of scope (a separate deferred item).
- **Binary modalities** (audio bytes, partial images) — `deltaField` is a string;
  base64 or a binary delta payload is a separate consideration. Set aside.
- **Client-side tools / suspend-resume** — separate deferred item.
