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
demo UI parity, and reasoning-model robustness** (partly committed on branch,
the reasoning-robustness + `gpt-5.5` default still uncommitted):

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
- **Stream the ignored deltas — one core change unblocks two of them.** Two
  entries in the `ignore` set are ignored for the _same_ reason: their stream id
  isn't a single top-level string key, which is all the `stream(...)` model can
  key on today.
  - **tool-call arguments** (`function_call_arguments.*`): the id is **nested** —
    the start (`output_item.added`) carries it under `item.id`, not a top-level
    field (findings §A).
  - **reasoning summaries** (`reasoning_summary_*`): the id is **composite** — a
    reasoning item emits one or more summary parts, each a
    `reasoning_summary_part.added` → `reasoning_summary_text.delta*` → `.done`,
    all sharing one `item_id` and distinguished only by a numeric `summary_index`,
    so the stream id must be `item_id + summary_index`.

  The fix is one generic core enhancement: let a stream family **derive its id
  from a nested/composite key** rather than a single top-level string. Then drop
  the relevant `ignore(...)` entries and add stream families — a
  `function_call_arguments` family (reducer appends deltas onto the in-progress
  `function_call` item's `arguments`) and a `reasoning` family (rendering the
  model's "thinking"). To reproduce reasoning-summary events for testing: opt the
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

Text **and server-side function calls** are complete end-to-end (codec +
transport + demo), and the demo has UI parity with the Vercel demo bar the
client-side tool surface. The remaining work, smallest/most-foundational first:

1. **`decodeLifecycle` mid-stream-join repair (small, self-contained).** Lets a
   client that joins while a reply is streaming reconstruct the in-flight message
   item. Independent of tools; the demo can already trigger the gap (open a second
   tab mid-stream). A good warm-up that also hardens what's shipped.
2. **Client-side tools + approvals (the remaining Vercel-parity gap).** Add
   `ToolResult` / `ToolApprovalResponse` to `OpenAIInput` (clean now — the
   conditional factories from `dc8ee25` mean the codec only exposes the factories
   whose variants it declares), wire suspend/resume, and add the approval/tool-card
   UI. This is where the run genuinely suspends (the agent goes away awaiting a
   client tool result / approval and a later invocation resumes it), so it is
   where the full `openaiRunOutcome` mapper — including its `suspend` arm — earns
   its place. Brings the OpenAI demo to full feature parity.
3. **Stream the ignored deltas (the `ignore` follow-up).** One core stream-model
   change — deriving a stream id from a nested/composite key — lets both the
   `function_call_arguments.*` (nested id) and `reasoning_summary_*` (composite
   `item_id + summary_index`) deltas leave the `ignore` set and stream as real
   families. See the Deferred entry. Realtime win; not parity-blocking.

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
