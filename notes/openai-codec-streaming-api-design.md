# OpenAI codec streaming — API design

_The "how" output of the API-design phase. Companion to
`notes/openai-codec-streaming-api-brief.md` (the handoff) and
`notes/lawrence-questions/streaming-target-model.html` (the agreed behaviour
target). This decides the concrete `stream()` / output-descriptor surface changes
that let the codec stream every incremental family OpenAI emits._

**Status:** design, for review before implementation. No codec families are
written yet; this pins the core `src/core/codec` surface they'll consume.

---

## 1. What this decides, and the one insight it rests on

The behaviour target is agreed (see the target doc): every streamable family is
the **same shape** — a text value growing into a **slot**, where a slot is
`(item, position)` opened by some start event. Five families must become real
`stream(...)` families: `output_text` (rename of today's `'text'`), `refusal`,
`reasoning_summary_text`, `reasoning_text`, `function_call_arguments`.

Today's `stream()` can't express them because it assumes three things that the
real events break:

1. the stream id is a **single top-level string key**, read the same way on every
   phase;
2. the **start event type alone** names the family;
3. a decoded delta is stripped to **`{ id, fragment }`** — the id echoed back and
   the position index dropped.

So three capabilities have to exist in the **generic** layer (`src/core/codec`),
consumed by the OpenAI codec via new descriptors and leaving the Vercel codec
working. This doc gives each a concrete surface, then works the hardest family
(`function_call_arguments`) end-to-end, because it's the one that stresses all
three at once and forced the sharpest design choices.

The single organising principle that falls out:

> **The stream id is an opaque transport handle; the reducer routes only on real
> re-stamped fields.** Id = uniqueness for the Ably message. Fields = semantics
> for the reducer. They stop being the same value.

---

## 2. The surface, at a glance

All changes are to `OutputStreamSpec` in `src/core/codec/output-descriptors.ts`
and its two drivers (`output-descriptor-encoder.ts`, `output-descriptor-decoder.ts`).

| Cap | Change | Phase | Driver |
| --- | --- | --- | --- |
| 1 | `idField` → **`streamId`** (`{ field }` \| extractor) | encode-only | encoder |
| 2 | add **`deltaFields`** + **`decodeDelta`** hatch; drop the id-echo; `item_id` becomes a field | decode-only | decoder |
| 3 | add **`startWhen`** discriminator; start-candidate list + decline→`event()` | encode-only | encoder |

Decode **dispatch** is untouched by Caps 1 and 3: a family is always resolved by
its unique `kind` header, so shared *start types* never collide on the decode
side — the collisions are only an encode-time concern.

---

## 3. Cap 1 — `streamId`: a derived, opaque transport handle

**Today** (`output-descriptors.ts`, `OutputStreamSpec.idField`): one string key,
present on all three phases; the encoder reads `prop(chunk, idField)` → the Ably
`stream-id` transport header, and the decoder echoes it back into the chunk
(`bag[idField] = tracker.streamId`).

**Proposed:**

```ts
streamId:
  // field — extract a single top-level string key, identical on every phase (Vercel's case)
  | { field: StringKeyOf<ResolveType<U, S>> & StringKeyOf<ResolveType<U, D>> & StringKeyOf<ResolveType<U, E>> }
  // derived — computed from whichever phase chunk the encoder is handling
  | ((chunk: ResolveType<U, S> | ResolveType<U, D> | ResolveType<U, E>) => string);
```

The field case is a `{ field }` object, not a bare string, so the call site reads
as *extract this property* rather than *the id is this literal*. The sibling
`deltaField` can stay a bare string because it is *always* a field and its name
carries that; `streamId` is *sometimes* derived and its name doesn't, so it wraps
the field case to signal the mode. The function arm stays unwrapped — a function is
self-evidently "compute it," and `typeof === 'function'` discriminates the two.

A **single extractor over the phase union** covers both sub-needs the brief
identifies, without a per-phase record:

- **compose** (text / refusal / reasoning_text / summary) — no single field is
  unique, so combine coordinates: `` (c) => `${c.item_id}:${c.content_index}` ``.
  Valid on all three phases (`content_part.added`, `output_text.delta`,
  `output_text.done` all carry both top-level).
- **relocate** (fn-args) — the same id lives in different places per phase:
  `(c) => c.type === 'response.output_item.added' ? c.item.id : c.item_id`.
  TypeScript narrows on `c.type`; the start reads nested, delta/end read
  top-level.

This is **encode-only**. The decoder never recomputes the id — it reads it off the
`stream-id` transport header as an opaque handle (`decoder.ts`) and, under Cap 2,
never writes it into a chunk field. We rename `idField` → `streamId` because it is
no longer necessarily a field (the `{ field }` arm is; the function arm isn't).

*Encoder:* `const streamId = typeof d.streamId === 'function' ? d.streamId(chunk) : prop(chunk, d.streamId.field)`.

**Why not a per-phase record `{ start, delta, end }`?** More verbose for compose
(the same function written three times) and it buys nothing the union extractor
lacks — relocate is expressible by branching on `c.type`. Rejected.

---

## 4. Cap 2 — deltas carry their real fields

**Today** (`output-descriptor-decoder.ts`, `buildDelta`): emits exactly
`{ [idField]: streamId, [deltaField]: delta }`. The `item_id` there is just the
stream id echoed back (it works only because today stream id == `item_id`), and
the position index is dropped — so the reducer can't tell which slot the text
belongs to and appends to the trailing part (`reducer.ts` `trailingOutputText`).

**Cap 1 forces this to change:** once the stream id is composite (`msg_1:0`) it
can't be echoed as `item_id` without corrupting it. So the id-echo goes away
entirely, and the delta's real fields are reconstructed instead.

### 4a. Two mechanisms — and why that isn't a new duality

```ts
/** Fields the *delta* chunk carries — distinct from the start/end `fields`
 *  (e.g. `content_part.added` carries `part`; the real `output_text.delta`
 *  does not). Read from the re-stamped persistent (start) headers. Default []. */
deltaFields?: readonly FieldFor<ResolveType<U, D>>[];

/** Escape hatch for a delta whose real fields can't be read straight from a
 *  header key — e.g. a value nested inside a carried envelope. Mirrors the
 *  existing `decodeEnd` / `decodeDiscrete` hatches. */
decodeDelta?: (ctx: OutputStreamDeltaContext) => ResolveType<U, D>[];
```

```ts
interface OutputStreamDeltaContext {
  /** The opaque transport stream id (never parsed for routing). */
  streamId: string;
  /** This delta's text fragment. */
  delta: string;
  /** The stream's persistent (start) codec headers, re-stamped on every append. */
  codecHeaders: Record<string, string>;
}
```

Decoder (all three phases lose the `bag[idField] = streamId` line):

```ts
buildStart: (t) => [rebuild(desc.start, readFields(desc.fields, t.codecHeaders))],

buildDelta: (t, delta) => {
  if (desc.decodeDelta)
    return desc.decodeDelta({ streamId: t.streamId, delta, codecHeaders: t.codecHeaders });
  const bag = readFields(desc.deltaFields ?? [], t.codecHeaders);
  bag[desc.deltaField] = delta;
  return [rebuild(desc.delta, bag)];
},

buildEnd: (t, closing) => /* decodeEnd hook, else */ [rebuild(desc.end, readFields(desc.fields, closing))],
```

The declarative `deltaFields` is the default; `decodeDelta` is the escape hatch
for the one irregular family (see §6). **This is the same declarative-default +
`decodeX`-hatch shape the end phase already has** (`fields` default + `decodeEnd`)
and the discrete phase has (`fields`/`data` default + `decodeDiscrete`). Giving
the delta phase the same shape makes it consistent, not novel. We considered
collapsing to **only** the hatch (one mechanism) and rejected it — see §7.

### 4b. Why reading delta fields from the start headers is *correct*, not a hack

It reads as though we're "shoving start fields onto the delta," but a slot's
routing coordinates (`item_id`, `content_index`) are **invariant for the lifetime
of one stream instance** — one slot's id and position don't change between its
first delta and its last. The encoder already re-stamps the start's codec headers
(`persistentCodec`) on every append, so those constant coordinates ride every
delta on the wire; the decoder simply wasn't copying them onto the delta object.
The declarative read is therefore precisely the delta's own real shape, sourced
from where a stream-invariant value lives.

### 4c. `item_id` becomes an ordinary field

New invariant: **if a rebuilt chunk needs the id value as a property, declare that
property as a field.** For the content families, `item_id` moves from being the id
into the declared `fields` (written on the start, re-stamped on every append) and
into `deltaFields` (read back per delta). The value was always on the wire; the
decoder just wasn't copying it.

---

## 5. Cap 3 — discriminated start + decline→`event()`

**Today** (`output-descriptor-encoder.ts`): `streamByPhase` maps `type → {descriptor, phase}`,
so a chunk routes to a stream by `type` alone. That breaks the moment a start type
is **shared**: `content_part.added` opens text *or* refusal *or* reasoning_text
(told apart by `part.type`); `output_item.added` opens the fn-args stream *only*
when `item.type === 'function_call'`.

**Proposed:** a payload discriminator, and a split of the encoder's dispatch into
*start candidates* (a list per type, discriminated) and *continuations*
(delta/end, still 1:1 — those types are unique per family).

```ts
/** Payload discriminator resolving a shared start event to this family.
 *  Default () => true. When no candidate for a start type matches, the chunk
 *  is not a stream start — dispatch falls through to the discrete `event()`
 *  descriptor for that type; `stream()` publishes nothing. */
startWhen?: (chunk: ResolveType<U, S>) => boolean;
```

Encoder registry + dispatch:

```ts
streamStartsByType: Map<string, OutputStreamDescriptor<U>[]>          // shared start types → candidate list
streamContByType:   Map<string, { descriptor; phase: 'delta' | 'end' }>  // delta/end, 1:1

// on a chunk:
const candidates = streamStartsByType.get(type);
if (candidates) {
  const d = candidates.find((c) => c.startWhen?.(chunk) ?? true);
  if (d) { /* startStream */ return; }
  // decline → fall through to discrete dispatch (do NOT throw, do NOT stream)
} else {
  const cont = streamContByType.get(type);
  if (cont) { /* append | close */ return; }
}
// existing discrete / wildcard / ignore dispatch — handles the declined starts
```

- **Decode is unaffected** — families dispatch by unique `kind`, so shared start
  *types* never collide on decode.
- The declined `output_item.added` (message / reasoning items) lands on the
  existing `event('response.output_item.added')` descriptor, which is kept.
- **Retained invariant:** a given wire type is either a start or a continuation,
  never both, and start ≠ delta ≠ end within a family. The encoder still needs a
  distinct start to fire `startStream`.

**Rejected: the lazy-open / no-start alternative.** A broader core mode — a stream
with *no* start event, opened lazily on its first dedicated delta — would drop
discrimination entirely. We reject it: every family has a real reveal event that
carries the slot's part/item + index, which is a richer start, keeps one dispatch
policy ("a stream starts on the event that reveals its slot"), and matches what a
start-lead-in repair would synthesise. A lazy-open mode would add a second, weaker
start model for no family that needs it. (It looked briefly attractive *only* for
fn-args, as a way to dodge envelope carriage — see §6.4 for why we didn't take
that bait.)

---

## 6. The hard case worked end-to-end: `function_call_arguments`

This family stresses all three caps and is where the design earned its keep. The
brief flagged the "item_id problem"; grounding it in the real event shapes shows
the problem is bigger than item_id, and its resolution is what validates the
`decodeDelta` hatch.

### 6.1. Ground truth (`openai@6.44.0`)

```
output_item.added              { item: {id?, call_id, name, arguments:"", type:'function_call', status?}, output_index }
function_call_arguments.delta  { item_id, delta, output_index }
function_call_arguments.done   { item_id, name, arguments, output_index }        // NB: no call_id
output_item.done               { item: {id, call_id, name, arguments:<full>, ...}, output_index }  // still fires, discrete
```

Three load-bearing facts:

1. **`call_id` exists only on the `output_item.*` envelopes** — absent from both
   `function_call_arguments.delta` and `.done`. And `call_id` is essential: it
   pairs the tool result (`function_call_output`) and is what's fed back to
   `/responses`. So the args stream *alone* cannot reconstruct a usable
   function_call.
2. **The item id is nested + optional on the start (`item.id: string | undefined`),
   top-level + required on delta/done (`item_id: string`).** That's Cap 1's
   relocate, plus a type wrinkle (§6.5).
3. **`output_item.done` still fires**, as a separate discrete event, carrying the
   complete item after the args stream ends.

### 6.2. The real crux: envelope carriage

The moment `output_item.added` is claimed as the stream start (Cap 3), it stops
being published as a discrete `event()` for function_calls — and a stream start
publishes `data: ''`, with the accumulating **arguments text** owning the data
channel. So the item's identity (`id`, `call_id`, `name`) has nowhere to ride
except **codec headers**.

And the reducer needs that identity *at start time*: it seeds the fc item into
`byItemId` on `output_item.added`, and the args deltas route into it by id. If the
rebuilt start doesn't carry `{id, call_id, name}`, the deltas can't land and we
lose the very streaming we're building (the final args would still arrive via the
discrete `output_item.done`, but the incremental animation — the point — is gone).

**Conclusion:** the fn-args stream carries the fc item envelope in a start codec
header (`jsonField('item')`), and `buildStart` reconstructs an `output_item.added`
from it so the reducer seeds `byItemId`. `output_item.done` continues to arrive
discretely as the authoritative complete item (added creates, done replaces — the
reducer already handles both).

### 6.3. item_id on the delta — read it from the carried item

The decoded `function_call_arguments.delta` needs top-level `item_id` for routing.
Its source on the start is nested (`item.id`), which a flat `FieldFor` can't read —
so `deltaFields` can't express it. But the item envelope we're already carrying
(§6.2) is re-stamped on every append, so it's on `tracker.codecHeaders` when the
decoder rebuilds each delta. So `decodeDelta` reads it straight out:

```ts
decodeDelta: ({ delta, codecHeaders }) => {
  const item = fItem.read(codecHeaders);   // the fc item, re-stamped from the start
  return [{ type: 'response.function_call_arguments.delta',
            item_id: item.id, delta, output_index: 0, sequence_number: 0 }];
}
```

This is why `decodeDelta` exists, and why it beats the two alternatives we
weighed:

- **vs. a gated id-echo** (`idField: 'item_id'`, stamping the transport id into the
  field): works only because fn-args' id is non-composite, but it reuses the
  opaque transport handle as a routing value — the exact coupling the design sets
  out to remove. `decodeDelta` reads a *real* wire field (the carried `item`),
  keeping the reducer id-agnostic to the letter.
- **vs. a new `deriveStartHeaders` primitive** (flattening `item.id` into a
  dedicated top-level header so `deltaFields` could read it): a whole new core
  concept for one consumer, when the value is already present inside the envelope
  we must carry anyway. YAGNI.

So `decodeDelta` keeps the wire-shaping *inside the codec*: the codec decides how
the fc item rides the wire, symmetrically — the same descriptor drives encode,
decode, and history — without inventing a new event type upstream of the codec.
The tempting-but-wrong alternative is to normalize the events into a clean
Ably-defined shape *before* the codec sees them; §7 ("emit-side normalization")
explains why that's the wrong place to absorb the mismatch.

### 6.4. Why not lazy-open for fn-args specifically

Lazy-open (§5) would let `output_item.added`/`.done` stay discrete (keeping
identity) and open the stream on the first `function_call_arguments.delta` —
dodging envelope carriage. We didn't take it: it resurrects the discrimination-free
start model we rejected wholesale, for one family, and envelope carriage turned
out cheap (a `jsonField('item')` we already needed for `call_id`/`name`). Paying a
core-model fork to save one header field is a bad trade.

### 6.5. The optional `item.id` — a guard, not a risk

`item.id` is `string | undefined` because `ResponseFunctionToolCall` is shared
between input (developer-constructed, id omitted) and output (streamed, id always
present). OpenAI populates it on every streamed `output_item.added` — it must, or
the deltas couldn't key off it. So it's a type artifact, not a runtime "sometimes
absent" case. We handle it with a boundary guard (TYPES.md bans `!`):

```ts
streamId: (c) => {
  if (c.type === 'response.output_item.added') {
    if (c.item.id === undefined)
      throw new Ably.ErrorInfo(
        'unable to stream function-call arguments; item has no id',
        ErrorCode.InvalidArgument, 400);
    return c.item.id;
  }
  return c.item_id; // top-level, required on delta/done
}
```

This is the single natural chokepoint — without an id we could form neither a slot
key nor a `byItemId` entry, so failing fast here is exactly right. It lives in the
OpenAI codec's extractor; the core `streamId: (chunk) => string` signature is
unaffected.

---

## 7. Rejected alternatives (with reasoning)

- **Per-phase `streamId` record `{ start, delta, end }`** — more verbose for
  compose, expresses nothing the union extractor can't (relocate branches on
  `c.type`). §3.
- **Gated id-echo (`idField: 'item_id'`) for fn-args routing** — reuses the opaque
  transport handle as a routing value; only "safe" for non-composite ids, and
  against the design's core separation. Superseded by `decodeDelta`. §6.3.
- **A `deriveStartHeaders` primitive** — new general core concept for one consumer,
  when the value already rides the envelope we carry anyway. §6.3.
- **Delta carries its own headers on each append** (encoder stamps `deltaFields`
  per append; decoder reads the append message's headers) — more invasive: changes
  `appendStream`'s re-stamping contract and threads per-append codec headers into
  `buildDeltaEvents`. Unnecessary, because the delta's routing coordinates are
  stream-invariant and already re-stamped from the start (§4b).
- **All-hatch delta (drop `deltaFields`, keep only `decodeDelta`)** — one mechanism
  in concept, but the four common families would each hand-write a partial delta
  object with placeholder required fields (`output_index: 0`, `sequence_number: 0`,
  …) and own the `partial → U` cast the declarative driver otherwise centralises.
  More code, more drift, and it makes the delta the one phase that's all-hatch
  while start/end/discrete keep a declarative default. **Revisit trigger:** if a
  large share of the later hosted-tool families also need the hatch, the
  declarative path earns its keep less — reassess then, not now.
- **Lazy-open / no-start stream** — a second, weaker start model; every family has
  a real reveal event, so it's unneeded. §5, §6.4.
- **Emit-side normalization** (wrap OpenAI events in an Ably-defined event type
  upstream of the codec, à la a bespoke `UIMessageChunk`) — Vercel is "pure" only
  because `UIMessageChunk` is *already codec-shaped*; OpenAI's events aren't, and
  that impedance has to be absorbed somewhere. An emit-side wrapper (a) moves the
  mismatch rather than removing it and makes it *asymmetric* (decode/history still
  need the full reconstruction), (b) breaks the "it's just OpenAI" contract — the
  reducer is a deliberate mirror of OpenAI's own `ResponseAccumulator`, and a
  custom taxonomy means maintaining a parallel event vocabulary or normalizing
  *and* de-normalizing, and (c) runs against AIT-742's whole framing ("stream the
  real events; if we can't, widen `stream()`"), whose payoff is that the hosted-tool
  families then fall out as plain descriptor entries. A **bounded** version of the
  idea is legitimate and *is* in the plan: the codec shapes the *wire
  representation* internally (e.g. carrying the fc item in a header), symmetrically,
  without inventing a new event type the agent emits. That's the line — shape the
  wire inside the codec; don't add an asymmetric pre-codec layer.

---

## 8. Backward compatibility — Vercel migration (mechanical)

All three Vercel streams (`src/vercel/codec/outputs.ts`) have unique, non-shared
start types and single top-level ids, so:

- `idField: 'id'` → `streamId: { field: 'id' }` (unchanged behaviour);
  `tool-input` → `streamId: { field: 'toolCallId' }`.
- add `deltaFields: [fId]` (resp. `[fToolCallId]`). `fId` / `fToolCallId` are
  already in `fields`, so they're already re-stamped; this just declares that the
  delta carries them. The reconstructed delta is byte-identical to today's
  `{ id, delta }`.
- no `startWhen` (defaults to `() => true`), no `decodeDelta`.

`decodeEnd` / `decodeDiscrete` / `onEnd` for `tool-input` are untouched — they
already take `streamId` explicitly. Dropping the `bag[idField] = streamId` echo is
safe because the id-bearing field is already in `fields` for every Vercel stream.

The existing Vercel + OpenAI descriptor/driver unit tests staying green is the
proof of backward compatibility.

---

## 9. What this enables downstream (not designed here)

With Cap 2, decoded deltas carry `content_index`, so the OpenAI reducer can key the
target part by `content[content_index]` instead of `trailingOutputText`
(`reducer.ts`). That reducer change — and the fn-args `byItemId` seeding described
in §6.2 — is **codec-layer work in a later phase**; this doc only ensures the caps
make it expressible.

Hosted-tool streams (`mcp_call_arguments`, `code_interpreter_call_code`,
custom-tool input) are the same shape — "text/data growing into an item's slot,
opened by a discriminated item envelope." Once the three caps land, they're
additional descriptor entries, which is the evidence the widened model is sound
rather than over-fitted to text. **Out of scope and untouched here:**
`decodeLifecycle`, binary modalities (audio bytes / partial images — `deltaField`
is a string), and client-side tools / suspend-resume.

---

## 10. Family × capability matrix

| family | Cap 1 | Cap 2 | Cap 3 |
| --- | --- | --- | --- |
| `reasoning_summary_text` | compose (`item_id + summary_index`) | `deltaFields` | — (dedicated start `reasoning_summary_part.added`) |
| `output_text` | compose (`item_id + content_index`) | `deltaFields` | ✅ shared `content_part.added` [`part.type`] |
| `refusal` | compose | `deltaFields` | ✅ shared `content_part.added` [`part.type`] |
| `reasoning_text` | compose | `deltaFields` | ✅ shared `content_part.added` [`part.type`] |
| `function_call_arguments` | relocate (`item.id` / `item_id`) | `decodeDelta` (reads carried `item`) | ✅ `output_item.added` [`item.type`], non-fc → `event()` |

---

## 11. Implementation sequence + validation

### 11a. Dependency shape (what forces what)

- **Cap 1 field-form (`{ field }`)** is backward-compatible on its own — a rename
  of `idField`, same wire behaviour, the id can still be echoed into `streamId.field`.
- **Cap 1 derived-form (the extractor)** produces a composite/relocated id that
  *can't* be echoed into a chunk field without corrupting it, so a derived-id family
  is undecodable without **Cap 2**. ("Cap 1 forces Cap 2.")
- **Cap 2 removes the id-echo**, which the two existing consumers (Vercel's three
  streams, OpenAI's `'text'`) depend on. So **they migrate in the Cap 2 commit** —
  the fix-up is along the way, not afterwards. We take the clean break rather than
  keep the echo as a compat path (that would be the dual mechanism / gated echo the
  design rejects).

None of the groundwork is speculative: each capability is justified by the family
that first consumes it — the extractor arm by F1, `startWhen` by F2, `decodeDelta`
by F3 — and Caps 1–2's plumbing is immediately exercised by the existing-consumer
migration. The commit boundaries below are **provisional**: the intent is to rework
them before shipping so the pure-core groundwork lands in isolation, ahead of any
OpenAI-family commits.

### 11b. Groundwork (backward-compatible; tree green at every step)

- **GW1 — Cap 1 rename → `{ field }`.** Mechanical: `idField` → `streamId: { field }`
  across the spec, both drivers, and both consumers; echo preserved (into
  `streamId.field`). Zero behaviour change.
- **GW2 — Cap 2: `deltaFields` + `decodeDelta`; drop the echo.** Decoder stops
  echoing and reads `deltaFields`; migrate Vercel (`deltaFields: [fId]` / `[fToolCallId]`)
  and OpenAI `'text'` (add `item_id` to `fields` + `deltaFields`) so decoded chunks
  are byte-identical.
- **GW3 — Cap 3: dispatch refactor + `startWhen`.** Splittable: (a) mechanical —
  restructure the encoder's `streamByPhase` into start-candidates + continuations,
  single-candidate behaviour unchanged; then (b) additive — add the `startWhen`
  discriminator (default `() => true`) and the decline→`event()` fall-through.

### 11c. Families (each drops its `ignore(...)` entries)

1. **`reasoning_summary_text`** — first derived-id family (adds the extractor arm):
   Cap 1 compose (`item_id + summary_index`) + Cap 2 `deltaFields`, dedicated start
   (`reasoning_summary_part.added`), no `startWhen`, no hatch. Proves the
   id-derivation and delta-field changes end-to-end on the simplest family.
2. **`output_text` / `refusal` / `reasoning_text`** — first shared start (exercises
   Cap 3): three descriptors sharing `start: 'response.content_part.added'`, each
   `startWhen: (c) => c.part.type === '…'`; `fields` includes `part`, `deltaFields`
   does not. Renames `'text'` → `output_text` with a compose id and a
   `content_index`-keyed reducer — the real fix for the latent single-part bug.
3. **`function_call_arguments`** — Cap 1 relocate + the `item.id` guard, Cap 3
   discriminated start with decline→`event()`, the item-envelope-in-a-start-header,
   `buildStart` re-emitting `output_item.added`, reducer `byItemId` seeding, and
   `decodeDelta`.

**Note:** OpenAI `'text'` is touched twice by design — a minimal migration in GW2
(keep single-part text working under the echo-free decoder), then the real
generalization in family (2).

**Validation:**

- `pnpm run typecheck` — the `streamId` union and `startWhen` / `deltaFields` /
  `decodeDelta` generics must narrow cleanly through `outputBuilder`'s single cast
  boundary.
- `pnpm test` — existing Vercel + OpenAI descriptor/driver unit tests green after
  GW1/GW2 (the byte-identical consumer migration is the backward-compat proof),
  plus new driver tests for: composite-id encode, `deltaFields` reconstruction,
  `decodeDelta`, and the `startWhen` decline→`event()` fallthrough.
- Codec-level integration roundtrip per family as it lands (publish encoded
  messages to a real channel; assert the decoder reconstructs the expected chunks).

---

## 12. Open items to revisit

- **All-hatch reassessment** once the hosted-tool families are real (§7): if most
  need `decodeDelta`, reconsider whether `deltaFields` still earns its place.
- **Header weight** of the re-stamped fn-args `item` JSON (§6.2) — tiny today
  (id/call_id/name/empty args); if it grows, stamp `call_id`/`name`/`id` as
  discrete fields instead of the whole item.
- **`content_part.added` with an unknown `part.type`** (§5): no candidate matches
  and there's no discrete `content_part.added` descriptor today, so it would hit
  the encoder's throw-on-undescribed safety net. Decide per family set whether to
  add a discrete fallback or let it throw.
