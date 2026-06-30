# OpenAI codec — Phase 0 spike findings

_Output of the de-risking spike described in `openai-codec-phase-0-spike.md`.
Companion rationale in `openai-codec-recommendations.md` (referenced as §N).
The spike code is disposable scratch under `test/openai-spike/` (run with
`pnpm test`); it is **not** the real codec. Verified against `openai@6.44.0`
(see "Environment" below)._

## Verdict

| Goal                                                                                             | Result                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(1) No `src/core` change** — the Responses target fits the existing `Codec`/transport contract | **Mostly confirmed, with one precise strain to review** (function-call argument _streaming_; see H3/H7). The strain has a no-core-change workaround; a small, additive core option would remove it. |
| **(2) Items-based `TMessage` works** — renders cleanly, near-identity to model input             | **Confirmed.** Items render via a small `call_id` pairing helper; `toResponsesInput` is literal concatenation (identity on item references).                                                        |

The scratch codec **assembles via `defineCodec` with no change to `src/core`**,
typechecks against the four-param `Codec<TInput, TOutput, TProjection, TMessage>`
contract, and 14 hypothesis tests pass. Two contract observations are surfaced
below for the codec-API author to review — neither was changed.

## Hypotheses

**H1 — string-append fits. ✅ Confirmed (for text).**
`response.content_part.added → response.output_text.delta →
response.output_text.done` maps onto one `stream(...)` family with
`idField: 'item_id'`, `deltaField: 'delta'` — both string-valued and present on
all three phases. Evidence: encoding a text run produces a streamed
`message.create` (`stream=true`, `status=streaming`, `stream-id=msg_1`) followed
by **string** `message.append`s that accumulate to the full text and a closing
`status=complete` append; decode + fold reconstructs the text item verbatim
(`test/openai-spike/hypotheses.test.ts`, "H1").

**H2 — one message per run. ✅ Confirmed.**
Two `/responses` calls in one run (a tool call, then a text answer) folded into
a single projection under one `codec-message-id` yield exactly one `getMessages`
entry whose items contain both the `function_call` and the `message`. The
`codec-message-id` is a clean boundary ("H2").

**H3 — concurrent tool-call streams compose. ⚠️ Premise refuted, behaviour confirmed.**
The literal hypothesis ("tool-call _streams_") does not hold: function-call
arguments **cannot be modelled as a `stream(...)` family** (see H7). Modelled as
discrete events instead, two interleaved concurrent function calls reduce
correctly — each keyed by its own `item_id`, arguments land on the right call
(`call_a → {"city":"SF"}`, `call_b → {"tz":"PST"}`), both directly and through
the wire ("H3"). So concurrency composes; it just isn't wire-streamed.

**H4 — items render cleanly + `call_id` pairing. ✅ Confirmed.**
`toRenderItems(turn)` (`pairing.ts`, ~30 lines) folds a `function_call` and its
matching `function_call_output` into one `ToolPair` keyed on `call_id`, drops the
result from the flat stream, and leaves plain items untouched. No merged "tool"
`TMessage` type is needed — `TMessage` stays a faithful item list ("H4").

**H5 — `toResponsesInput` is near-identity. ✅ Confirmed.**
It is literal concatenation of each turn's items. The assistant turn's output
items appear in the model input **by identity** (same object references — the
test asserts `input` _contains_ the exact item objects), and the conversation
ends with the `function_call` + its `function_call_output` ("H5"). The only
non-identity is a type-level cast at the boundary (output items are valid input
items at runtime but the `ResponseOutputItem`/`ResponseInputItem` types are not
mutually assignable) — see the note on `TMessage`'s item type below.

**H6 — client `ToolResult` appends to the suspended run on resume. ✅ Confirmed.**
A `tool-result` input carrying the same `codecMessageId` as the assistant run
appends a `function_call_output` (matching `call_id`) into the **same** message
as the call — one `getMessages` entry, call + result together ("H6").

**H7 — the descriptor split holds. ✅ Confirmed, with one strain.**
`defineCodec` assembles and `validateTables` passes: text is the one `stream(...)`
family (carries the coarse `status` header); lifecycle + structural + function-call
events are `event(...)` discretes (carry no `status`). The wire shows exactly
this: streamed messages carry `status`, discrete ones never do ("H7").

_The strain:_ the **function-call argument stream does not fit the stream model.**
A `stream(...)` family needs a single **top-level string** `idField` shared by
its start/delta/end phases. The natural start boundary,
`response.output_item.added`, exposes the call id only nested under `item.id` —
its sole top-level string key is the constant discriminator `type`. The arg
deltas (`response.function_call_arguments.delta/.done`) use top-level `item_id`,
but there is **no third `item_id`-bearing function-call event** to serve as a
distinct start (start/delta/end must be three distinct types). So the
`idField` intersection across the three phases is just `'type'` (a constant),
which can't disambiguate concurrent calls. Text escapes this only because
`content_part.added` happens to carry a top-level `item_id`.

**H8 — errors land on run-end; reducer stays out; refusal is content. ✅ Confirmed.**
`response.failed` and stream-level `error` are captured for `openaiRunOutcome`
but **never folded into items** (the partial message survives untouched).
`openaiRunOutcome` maps `failed`/`error` → `error`, `aborted` → `cancelled`,
`pendingClientTool` → `suspend`, else `complete`. A `refusal` folds as a normal
content part, not an error ("H8").

## Surfaced for review — does `src/core` need to change?

Neither of these was changed. Both are reported with their cost, per the
"change the API only if really necessary" rule.

### Observation A — stream `idField` can't name a nested id (H3/H7)

**What strains:** `OutputStreamSpec.idField` is `StringKeyOf<…>` — a top-level
string **property name** shared by start/delta/end. OpenAI's function-call start
boundary nests its id under `item.id`, so function-call argument streaming has
no expressible stream id.

**No-core-change workaround (used in the spike, and fine for Phase 1):** model
function-call args as **discrete events** — `output_item.added`,
`function_call_arguments.delta`, `.done`, `output_item.done` each as their own
discrete message. Folds correctly and composes concurrently (H3). Cost: tool-call
arguments do **not** use the transport's append-stream lifecycle — each delta is
a separate discrete publish, so there is no mid-stream-join recovery for args and
more messages on the wire. For a "weather in London" demo this is immaterial;
for long tool arguments it is a real (if modest) regression vs text streaming.

**Precise core change that would remove it (small, additive, type-safe):** allow
`idField` (and optionally `deltaField`) to be either a key name **or** an
extractor `(chunk) => string`, so a codec can name `c.item.id`. This is the one
change I'd put to the codec-API author. It does **not** block Phase 1.

### Observation B — the reducer can mirror, but not _call_, `accumulateResponse` (qualifies the "fold = accumulateResponse" decision)

The SDK's `accumulateResponse` (`openai/lib/responses/ResponseAccumulator`) locates
the item to mutate by **`event.output_index`** — a positional index into
`Response.output`. That index rides only on the structural/lifecycle events; the
codec's wire stream model strips a streamed delta down to `(stream-id, text)`
(`output-descriptor-decoder.ts` `buildDelta` emits only `idField` + `deltaField`,
and there is no per-delta decode hatch to re-attach `output_index`). So after a
wire round-trip a `response.output_text.delta` no longer carries `output_index`,
and `accumulateResponse` would throw `missing output at index undefined`.

**Implication:** the client-side reducer must accumulate **keyed on `item_id`**
(the stream id it _does_ have), i.e. a faithful **mirror** of `accumulateResponse`
re-keyed — not a verbatim call to the SDK function on the decoded stream. This is
**entirely codec-side (no core change)** and the reduction logic is otherwise
identical, but it qualifies the brief's "mirror **or directly call**": directly
calling is viable only on the raw pre-wire event stream (agent side), not on the
decoded stream (client side). The spike's reducer is the re-keyed mirror.

_Minor related note:_ `content_index` is dropped on streamed deltas for the same
reason. The spike handles one text part per item (append to the item's trailing
`output_text` part); a message with multiple text parts in one item would need
`content_index` preserved — carry it as a stream header if that case matters.

### Observation C — the real codec needs a `decodeLifecycle` policy for mid-stream join (no core change; not exercised by the spike)

Mid-stream join / history hydration was out of the spike's scope, but reading
`docs/internals/codec-interface.md` (the lifecycle-tracker / `decodeLifecycle`
sections) flags a requirement the real codec must meet. The spike reducer
assumes `response.output_item.added` arrives **before** the text stream's
`content_part.added` + deltas (it creates the item, which the deltas then find
by `item_id`). On a mid-stream join the decoder's first-contact path
reconstructs the _stream_ (`content_part.added` + deltas) but the **discrete**
`output_item.added` that created the item may have been missed — so the deltas
would find no item and the text would be dropped.

The Vercel codec solves the same problem with a `decodeLifecycle` policy
(synthesising the `start` lead-in on `onStreamStart`). The OpenAI codec needs
the analogue: synthesise the `output_item.added` (message item) lead-in when a
text stream starts mid-flight. This is **expressible with the existing
`decodeLifecycle` mechanism — no core change** — and it coheres neatly with
Observation B: because the reducer keys on `item_id` (= the stream id, which the
tracker has) and not `output_index`, the synthesised lead-in needs no positional
index either. Worth building and testing in Phase 1; the spike does not cover it.

### `TMessage` item type (informs decision #2, not a core change)

`TMessage` items are typed `ResponseOutputItem | ResponseInputItem` rather than
just `ResponseOutputItem`, because a user turn is an input message and a tool
result is `function_call_output` (input-only). This is the §5 insight made
concrete and keeps `toResponsesInput` identity at runtime; the cast at that
boundary (B above) is the only seam.

## Environment / caveats

- **`openai@6.44.0`** (added as a devDependency for the spike). The public
  `accumulateResponse` export (the one the recommendations cite) only landed in
  **6.45.0**, which is currently blocked by this workspace's pnpm
  `minimumReleaseAge` policy (published 2026-06-24). The spike therefore
  **mirrors** the accumulator subset rather than importing it; the 6.44.0 private
  `#accumulateResponse` was read and confirmed to use the identical
  `output_index`-keyed logic, so the mirror is faithful. The real codec can import
  the public function once 6.45.0 clears the release-age gate — subject to
  Observation B (it's usable agent-side, not on the decoded stream).
- Event field shapes verified against `openai-node` `src/resources/responses/responses.ts`.
- The spike was built from the codec **source** (`src/core/codec/*`, the Vercel
  codec) directly. Findings were afterwards cross-checked against
  `docs/internals/codec-interface.md`: it corroborates Observation B (delta
  reconstruction carries no `fields`) and the list-shaped `getMessages`, and
  surfaced Observation C (the `decodeLifecycle` requirement).

## Disposable artifacts to revert (not for merge)

- `test/openai-spike/**` — the entire scratch codec + tests.
- `package.json` / `pnpm-lock.yaml` — the `openai` devDependency.
- `eslint.config.js` — the `test/openai-spike/**` ignore entry.
