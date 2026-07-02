# OpenAI codec — build log & handoff

_Running record of the real OpenAI Responses codec build (AIT-742), and the
starting point for the next agent. It covers what has been built **for real**
since the spike, the decisions made along the way, and what to do next. For the
other AIT-742 notes and how they relate, see the next section._

## The notes, and how they fit

The AIT-742 notes form a narrative; read in this order. This build log is the
**live entry point** (kept current); the rest are fixed background.

1. `openai-codec-investigation.md` — the original AIT-742 context, requirements,
   and raw investigation (where the question started).
2. `openai-codec-recommendations.md` — the decisions and their rationale (target =
   Responses; `TMessage` = a turn's items; the `§`-numbered sections this log and
   the findings cite).
3. `openai-codec-phase-0-spike.md` — the de-risking spike brief: what to build and
   prove before committing to the approach.
4. `openai-codec-phase-0-findings.md` — the spike's results, including the `§A`
   (function-call `idField` strain) and `§B` (`item_id` re-keying) findings
   referenced below. The spike code under `test/openai-spike/` is disposable.
5. `openai-codec-build-log.md` — **this doc**: the real build since the spike, the
   decisions made along the way, and the next step.

## Status

Committed increments (on branch `AIT-742-openai-codec`):

- `a2a1372` — codec + `@ably/ai-transport/openai` entry point: streamed assistant **text output**.
- `9973a6c` — `ABSTRACTIONS.md` rule refresh + docs for the new entry point.
- `361d273` — **user-message input wire** (text prompts).
- `892d62c` — `toResponsesInput` model-input helper + this build log.
- `dc8ee25` — **core**: type the well-known **tool** factories conditionally on `TInput` so a _partial_ codec satisfies `Codec`.
- `36a4d33` — **OpenAI**: the **`regenerate`** signal on the `ai-input` wire.
- `f40e9dc` — **demos**: the OpenAI Responses text-only `useClientSession` demo.

Latest increment — **server-side function calls, the `ignore` escape hatch,
demo UI parity, and reasoning-model robustness** (all committed on branch
`AIT-742-openai-codec`, unpushed):

- **codec**: a `function_call_output` output event (`OpenAIOutput` widened to
  `ResponseStreamEvent | FunctionCallOutputEvent`) + descriptor entry + reducer
  arm. The `function_call` itself needs no new codec code — it is a
  `ResponseOutputItem`, so it already rides `output_item.added`/`output_item.done`
  (the `done` carrying complete arguments).
- **core**: a third output-descriptor construct, `ignore(type)` — the escape
  hatch for provider events a pass-through codec doesn't yet stream. The encoder
  drops listed types and throws on anything else (see the decision note).
- **reasoning-model robustness**: the OpenAI `ignore` set covers a reasoning
  model's streamed summary / raw reasoning text, refusals, and text annotations
  as well as the `function_call_arguments.*` deltas, so a reasoning model
  (`gpt-5.5`, now the demo default) streams its answer without tripping the
  safety net. An **exhaustive inventory** of every not-yet-modelled
  `ResponseStreamEvent` (which are ignored vs which still throw) is documented at
  the `ignore` entries in `descriptors.ts`, authoritative against `openai@6.44.0`.
- **demo**: a `getWeather` server tool (`tools.ts`), the agentic loop
  (`agent-stream.ts`: model turn → run tools → emit `function_call_output` →
  continue, all in one run, no suspend) piping the **raw** `/responses` stream
  (the old `supported-events.ts` filter is deleted — the codec's `ignore` set
  replaces it), the mock model emitting a function call for weather prompts, a
  `WeatherCard` rendered via a `toRenderItems` call/output pairing helper, and
  **suggestion chips** (`useDemoProgress` + `SuggestionChips`) for UI parity with
  the Vercel demo — clickable prompt chips plus gesture hints that drop off as
  each step is demonstrated, kept in sync across clients via the tree.

The codec **round-trips text and server-side tool calls both directions** at the
codec level, and **drives the generic transport end-to-end** through the demo
against real OpenAI. All green: typecheck, lint, format, the full unit suites
(SDK + demo), the build, codec-level integration roundtrips over real Ably
(including the tool-call roundtrip), and the demo's Playwright e2e (11/11, mock
model + sandbox app — including the server-side weather card and the
suggestion-chip lifecycle). Reviewed with `/code-review-all`.

## Scope update — the streaming model is now in scope (standup, 2026-07)

The "shippable as text + server tools" verdict further down was written **before**
a standup that reframed the priority. Mike's point: **if we can't stream tool-call
inputs, that isn't something to defer quietly — we need to understand why, and
decide whether the codec _interface_ has to change.** A tool call whose arguments
only land at `output_item.done` (no incremental streaming) is half-baked tool
support for a realtime product, and we don't want to ship that.

Digging into it turned up more than the tool-call gap:

- **Streaming tool-call inputs needs a core `stream()` change, not a codec tweak** —
  and the same change unblocks reasoning summaries, refusals, and raw reasoning.
  The bar became: **stream everything OpenAI can stream; if we can't, the model is
  wrong.**
- **Our `output_text` support is itself half-baked.** It assumes _one text part per
  message_ and can't target a specific `content[content_index]` — the very same
  "single top-level stream id" limitation, hiding in the one family we _do_ stream.
  It works today only because a message currently has one text part.

So "stream the ignored deltas" is **no longer a later, not-parity-blocking polish
item** (as the Deferred entry and Next-step §5 originally framed it). It's a **core
codec-interface question** — three generic `stream()` capabilities — that gates a
credible tool-call story and fixes a latent text-correctness gap. The target and
the gap analysis are worked out in a design-doc cluster; the API shape is the next
phase.

**Design docs, under `notes/lawrence-questions/`** — the human-facing _why_ and the
target:
`streaming-target-model.html` (the agreed target: five stream families, the
slot-reveal start policy, the three capabilities — start here),
`stream-construct-explainer.html` (how `stream()` works today),
`streaming-fncall-args-and-reasoning.html` (why today's model blocks these),
`openai-streaming-events-cheatsheet.html`, `data-model-grounding.html`.
The agent-facing _how_ (the API-design brief) is
`notes/openai-codec-streaming-api-brief.md`.

## What exists today

- **Entry point** `@ably/ai-transport/openai` → `ResponsesCodec` (+ types
  `OpenAIInput`/`OpenAIOutput`/`OpenAIItem`/`OpenAITurn`/`OpenAIProjection`) and
  `toResponsesInput`. `openai` is an optional peer dependency.
- **Output**: response lifecycle + `output_text` streaming + the `output_item`
  message envelope + `content_part` boundary → folded into an `OpenAITurn`.
- **Input**: the `user-message` `batch` fans a turn's `input_text` content parts
  out into one `ai-input` event each (reducer merges them by codec-message-id),
  plus the **`regenerate`** wire-only signal (kind-only; `target`/`parent` ride
  the transport headers, mirroring the Vercel codec). `OpenAIInput` is therefore
  `UserMessage<OpenAITurn> | Regenerate`.
- **`toResponsesInput(turns)`**: flattens the conversation into the `/responses`
  `input` array (near-identity — see the cast note below).
- **Partial-codec support in core** (`DefinedCodecFactories`): the well-known
  tool factories are typed present only when `TInput` carries the matching
  variant, so a codec whose `TInput` omits the tool variants (this one) is
  assignable to the generic `Codec`. The demo was the first transport-level
  consumer and surfaced this — see the decision note below.
- **Demo** `demo/openai/react/use-client-session/`: parity with the Vercel demo
  modulo client-side tools — streamed text, a **server-side tool call**
  (`getWeather` → weather card), **suggestion chips**, branch navigation, edit,
  regenerate, history rebuild on refresh, multi-client presence, debug pane.
  Backend pipes the raw `/responses` stream to `run.pipe`; the codec carries what
  it models and drops its `ignore` set (see below), throwing on anything else.
  Deterministic mock model for e2e; real model (default `gpt-5.5`, a reasoning
  model whose reasoning-summary events are ignored) behind `OPENAI_API_KEY`.

## Deferred — all marked `TODO(AIT-742)` in code

- **`decodeLifecycle`** (mid-stream-join repair): synthesise the
  `output_item.added` message-item lead-in when a text stream starts mid-flight,
  so a client joining mid-stream reconstructs the item. The full-stream path
  (incl. history hydration / refresh) works without it; this is the smallest
  remaining codec-correctness item, and the demo can hit it (a second tab opened
  while a reply is streaming).
- ~~**Function calls / server-side tools**~~ — **done** (this increment). See the
  decision note below; the chosen wire shape differs from the original plan
  (function calls ride the item envelopes; arg deltas are `ignore`d for now —
  not yet streamed; the tool result is the codec's own `function_call_output`
  output event).
- **Stream the ignored deltas — three core `stream()` capabilities (scope grew;
  see "Scope update").** Started as "one core change unblocks two of them"; the
  design work found it's broader (below). The two originally-noted families are
  ignored for the _same_ reason: their stream id isn't a single top-level string
  key, which is all the `stream(...)` model can key on today.
  - **tool-call arguments** (`function_call_arguments.*`): the id is **nested** —
    the start (`output_item.added`) carries it under `item.id`, not a top-level
    field (findings §A).
  - **reasoning summaries** (`reasoning_summary_*`): the id is **composite** — a
    reasoning item emits one or more summary parts, each a
    `reasoning_summary_part.added` → `reasoning_summary_text.delta*` → `.done`,
    all sharing one `item_id` and distinguished only by a numeric `summary_index`,
    so the stream id must be `item_id + summary_index`.

  **The fix grew past "one change, two families."** The design settled on **three
  generic `stream()` capabilities** — (1) a **derived** stream id (composite
  `item_id + index`, or a nested `item.id`); (2) decoded **deltas that carry their
  real fields** (so the reducer targets the right slot, not just "the trailing
  part"); (3) a **slot-reveal / discriminated start** (a stream starts on the event
  that first reveals its slot; shared starts like `content_part.added` /
  `output_item.added` are resolved by a payload discriminator). Together they
  unblock **five** families — add multi-part `output_text`, `refusal`, and
  `reasoning_text` to the two below — under the "stream everything" bar. All three
  are **`src/core/codec` changes**, consumed by the OpenAI codec via new
  descriptors (not OpenAI-only). The worked-out target, gap analysis, and open
  API-shape questions live in the design-doc cluster (`streaming-target-model.html`
  is the target) and the API brief `notes/openai-codec-streaming-api-brief.md`.

  Then drop the relevant `ignore(...)` entries and add the stream families. To
  reproduce reasoning-summary events for testing: opt the
  `/responses` request into `reasoning: { summary: 'auto' }` (the demo doesn't by
  default) AND use a reasoning-heavy prompt — a trivial one yields ~0 reasoning
  tokens and an empty summary; the 12-ball weighing puzzle against `gpt-5.5` is a
  reliable repro (see the note at the `ignore` entries in `descriptors.ts`).

- **Client-side tools + approvals** (suspend/resume): add `ToolResult` /
  `ToolApprovalResponse` to `OpenAIInput` — now clean on the type side thanks to
  the conditional factories above — plus the `openaiRunOutcome` mapper.
- **`openaiRunOutcome` mapper / run-end error forwarding**: the demo ends an
  errored run with `{ reason: 'error' }` and drops the original error (pipe's
  error is a plain `Error`, not an `Ably.ErrorInfo`, and an in-band
  `response.failed` doesn't even throw). The mapper should read
  `response.failed` / `error` / abort / pending-tool and convert+forward.
- **Codec-factory cleanup (option C)**: `dc8ee25` keeps one `as unknown as` cast
  in `defineCodec` and leaves phantom tool methods on a partial codec's runtime
  object (unreachable through the types). The cleaner shape — each codec passes
  the factory set it wants into `defineCodec` — removes both. Tracked by the
  `TODO(AIT-742)` on `DefinedCodecFactories` / the cast.
- **Reasoning, refusals, annotations, hosted tools**; **`input_image`/`input_file`** parts.
- **Revert the spike** (`test/openai-spike/`, its `eslint.config.js` ignore entry,
  and reconsider whether the `openai` dep pin needs updating) before release.

## Key decisions & open questions

- **`item_id`-keyed reducer.** The reducer mirrors OpenAI's `accumulateResponse`
  but keys on `item_id`, not the SDK's positional `output_index` (which the wire
  strips from streamed deltas). Codec-side only; no core change. [findings §B]
- **Function-call args can't (yet) be a stream family.** A `stream(...)` needs
  one top-level string `idField` on all three phases; the natural start
  (`output_item.added`) nests the id under `item.id`, so it can't satisfy it
  [findings §A — the one place the abstraction strained]. The spike floated
  modelling them as discrete per-delta events; we instead **`ignore` them for
  now** (the complete args arrive on `output_item.done`, so nothing is lost but
  the incremental typing). Streaming them properly means teaching the stream
  model to key on a nested id — tracked, not done.
- **`TMessage = OpenAITurn`** (a turn's items). A **user turn is assumed to be a
  single input message** (documented on the type and at both use sites); a
  role-discriminated `TMessage` is a possible future tightening (not done — it
  ripples through the committed output path).
- **The output↔input union cast** (in `toResponsesInput`, with a `TODO`): OpenAI
  models stream-output (`ResponseOutputItem`) and model-input (`ResponseInputItem`)
  as two distinct unions, neither a subtype of the other. The §5 truth — the
  output items we store are valid input — holds at runtime but isn't expressible
  in the types, so a `// CAST:` bridges them. Tightening `OpenAIItem` to a
  curated subset would remove it but **relocate** the cast into the reducer (and
  worsen its narrowing). **Open: understand/resolve this properly.**
- **Function-call wire shape (resolved, uncommitted).** Three sub-decisions:
  (1) the **`function_call` rides the existing item envelopes** —
  `output_item.added` (pending, args empty) → `output_item.done` (complete
  args). A `function_call` is a `ResponseOutputItem`, so the codec already
  encodes/decodes/folds it; no new descriptor or reducer arm. (2) **Streamed
  argument deltas (`response.function_call_arguments.*`) are not yet streamed** —
  we _want_ to stream them (realtime service), but they don't fit the current
  `stream(...)` model (findings §A: the start boundary nests the id under
  `item.id`, so there's no top-level id shared across start/delta/end). Until the
  stream model can key on a nested id, they go in the codec's `ignore` set (the
  output table's escape hatch): dropped on encode, with the complete args still
  arriving on `output_item.done` so the turn stays correct meanwhile. Not a
  "don't care" — a tracked gap. (3) The
  **server-executed tool's result is the codec's own `function_call_output`
  output event** — OpenAI never streams tool output (it is model _input_ on the
  next turn), so the agent publishes it explicitly; it folds onto the assistant
  turn beside the call, so the turn round-trips a complete call+output pair for
  rendering (paired by `call_id`) and for a follow-up `/responses` request. The
  run does not suspend — the agentic loop runs the tool and continues in place.
- **Unrecognised output events: throw by default, `ignore` as the escape hatch.**
  The encoder throws on an output event with no descriptor (a real safety net —
  an unexpected event is never dropped unnoticed). A pass-through codec over the
  `ResponseStreamEvent` union will see events it doesn't model, so the output
  descriptor table has a third construct — `ignore(type)` — naming the events the
  codec deliberately drops _for now_ because it hasn't yet built a streaming path
  for them (today: a reasoning model's streamed summary / raw reasoning text,
  refusals, text annotations, and the `function_call_arguments.*` deltas — the
  set that lets a `gpt-5.x` reasoning model stream its answer unbroken). Anything
  neither described nor ignored still throws — that stays true for opt-in hosted
  tools / modalities (web/file search, code interpreter, image gen, MCP, audio,
  custom tools). `descriptors.ts` documents the **exhaustive** inventory (ignored
  vs still-throwing) against `openai@6.44.0`. This lets the agent pipe the raw
  `/responses` stream with no pre-filter — the old `supported-events.ts` mirror
  is gone. The aim remains to stream everything we can, so entries leave the
  `ignore` set as their streaming is built (e.g. teaching the stream model a
  nested id would let the arg deltas stream). `ignore` lives on the output
  table, not the codec config, so each entry sits with its justifying comment
  next to the events it relates to.
- **Partial codecs vs `Codec` (resolved, `dc8ee25`).** `defineCodec` returns a
  `DefinedCodec`, which the transport consumes as a `Codec`. That assignability
  only held for a _full_ codec (every well-known input variant present) until the
  demo — the first transport-level consumer — exposed that a text-only codec's
  `DefinedCodec` over-promised the tool factories (`createToolResult` etc.
  returning `ToolResult<never>` ∉ `OpenAIInput`). Fixed by `DefinedCodecFactories`
  typing those factories present only when `TInput` carries the variant. **Open:**
  option C above removes the residual cast + phantom methods.

## Next step, with a suggested order

**Scope of this first iteration:** text streaming **+ server-side function
calls**. Client-side tools / approvals are deliberately out (they're first-class
in the Vercel AI SDK but not in OpenAI Responses) — a later iteration.

**Shippability verdict:** the functional core is credible and well-tested (unit

- real-Ably integration + demo e2e, robust across reasoning/non-reasoning
  models). Two things gate a _credible_ early-preview first pass — `decodeLifecycle`
  and verifying multi-turn on a reasoning model — with error-detail forwarding and
  the spike revert as the cleanup tail. Then it's shippable as text + server tools.

1. **`decodeLifecycle` mid-stream-join repair (main correctness gap, small).**
   Lets a client that joins/refreshes while a reply is streaming reconstruct the
   in-flight message item (synthesise the `output_item.added` lead-in). Full-stream
   and post-completion refresh already work; the hole is specifically mid-stream
   join. The Vercel codec has the pattern to mirror. The demo can trigger the gap
   (open a second tab mid-stream).
2. **Verify multi-turn on a reasoning model (unverified risk — needs a real key).**
   Defaulting to `gpt-5.5` means we resend prior items to `/responses`, and
   reasoning items have special input rules. Two facets:
   - **Facet A — the server-side tool loop (sharpest; core scenario, untested).**
     `agent-stream.ts` collects only the `function_call` from a response and
     re-appends `[function_call, function_call_output]` for the next `/responses`
     call — it drops the **reasoning item** that preceded the call. OpenAI's
     reasoning-model tool loop expects the reasoning item(s) fed back alongside
     the call, so this may 400 ("function call without its reasoning item") or, at
     best, make the model re-reason. Never run against a real reasoning model (e2e
     uses the mock; the text reasoning tests had no tool call). **Repro:** weather
     prompt on `gpt-5.5`. **Fix if needed:** in the loop, re-append the response's
     reasoning item(s) too — the idiomatic pattern is "append all output items,
     then the tool outputs," not just the function call.
   - **Facet B — cross-turn (regenerate/edit/second message).** `loadConversation`
     → `toResponsesInput` resends prior assistant turns' stored reasoning items.
     Pairing (reasoning + its message, in order) is preserved, so this is likelier
     fine, but bare-reasoning-item acceptance in a stateless input array under
     `store: true` (no `previous_response_id` / `encrypted_content`) is unverified.
     **Fix if needed:** strip reasoning items in `toResponsesInput` for cross-turn
     context (prior-turn reasoning usually isn't needed) — or keep them if accepted.

   Note we can't use `previous_response_id` chaining (the transport reconstructs
   the conversation from the Ably channel, not OpenAI's server-side response chain),
   so resending the input array — and getting reasoning-item input rules right — is
   inherent to the design.

3. **Run-end error forwarding (`openaiRunOutcome`) — polish.** Errored runs end
   generic (`{ reason: 'error' }`); the original error / in-band `response.failed`
   detail isn't surfaced. Fine for preview; nicer to forward.

Later iterations (beyond the first pass):

4. **Client-side tools + approvals (full Vercel-parity).** Add `ToolResult` /
   `ToolApprovalResponse` to `OpenAIInput` (clean now — the conditional factories
   from `dc8ee25` mean the codec only exposes the factories whose variants it
   declares), wire suspend/resume, add the approval/tool-card UI, and the full
   `openaiRunOutcome` mapper (incl. its `suspend` arm).
5. **Stream everything OpenAI streams (the `ignore` follow-up — scope grew).**
   No longer "one change / two families": **three generic `stream()` capabilities**
   (derived id · delta fields · slot-reveal/discriminated start) unblock **five**
   families and fix the half-baked single-part `output_text`. **Reclassified** by
   the "Scope update" (Mike's standup: don't ship half-baked tool-call support)
   from a later, not-parity-blocking item to a **core codec-interface question** —
   the priority ordering here is stale as a result and needs a rethink. Target:
   `streaming-target-model.html`; API shape: `openai-codec-streaming-api-brief.md`;
   then implement. See the Deferred entry.

Independent cleanups that can land any time: **option C** (codec passes its own
factory set — removes the `defineCodec` cast + phantom methods); and **reverting
the spike** before release. (The demo's hand-maintained supported-event filter
is already gone — replaced by the codec's `ignore` construct + throw-on-unknown.)

Open type questions to resolve alongside tools: the **output↔input union cast**
in `toResponsesInput` (a `function_call_output` is input-only, so tools make the
two unions diverge further — this is the moment to decide whether to curate
`OpenAIItem`), and whether `TMessage` should become **role-discriminated** once
assistant turns carry tool calls + outputs.

Study first: `src/openai/codec/`, `test/openai-spike/` (the §A/§4 evidence and
fixtures), `demo/vercel/react/use-client-session/` (its tools.ts / client-tool /
approval flow), and the core run lifecycle (`src/core/transport/types/{agent,run}.ts`,
`suspend`/`resume`). Follow `CLAUDE.md`'s workflow rules: typecheck/lint/format/test
after changes, review with `/code-review-all`, never commit without approval.
