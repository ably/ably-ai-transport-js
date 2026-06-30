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

The codec **round-trips text both directions** at the codec level, and now also
**drives the generic transport end-to-end** through a real demo
(`createAgentSession` / `createSessionHooks` parameterized by `ResponsesCodec`)
against real OpenAI. Reviewed with `/code-review-all` (14 concerns) and green:
typecheck, lint, full unit suite (SDK + demo), build, and codec-level
integration roundtrips over real Ably. The demo's Playwright e2e is wired (mock
model + sandbox app) but was not run in the last pass.

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
- **Demo** `demo/openai/react/use-client-session/`: full parity-minus-tools with
  the Vercel demo — streamed text, branch navigation, edit, regenerate, history
  rebuild on refresh, multi-client presence, debug pane. Backend filters the
  `/responses` stream to the codec's supported event types before `run.pipe`
  (the codec throws on the rest). Deterministic mock model for e2e; real model
  (default `gpt-4.1`, non-reasoning) behind `OPENAI_API_KEY`.

## Deferred — all marked `TODO(AIT-742)` in code

- **`decodeLifecycle`** (mid-stream-join repair): synthesise the
  `output_item.added` message-item lead-in when a text stream starts mid-flight,
  so a client joining mid-stream reconstructs the item. The full-stream path
  (incl. history hydration / refresh) works without it; this is the smallest
  remaining codec-correctness item, and the demo can hit it (a second tab opened
  while a reply is streaming).
- **Function calls / server-side tools**: descriptor entries + reducer arms for
  `function_call` + `function_call_arguments` (discrete events, not a stream
  family — findings §A), and the backend agentic loop (execute tool → append
  `function_call_output` → continue). The spike's `toRenderItems` `call_id`
  pairing helper (§4) is the model for rendering.
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
- **Function-call args are discrete events, not a stream family.** A `stream(...)`
  needs one top-level string `idField` on all three phases; the natural start
  (`output_item.added`) nests the id under `item.id`, so it can't satisfy it.
  [findings §A — this is the one place the abstraction strained]
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
- **The codec keeps throwing on unrecognised output types** (deliberate — a real
  safety net). A subset-codec over the pass-through `ResponseStreamEvent` union
  will therefore see events it can't encode (reasoning, annotations, …), so the
  **agent/demo must filter the stream to supported event types before
  `run.pipe`** rather than the codec silently dropping them. The demo does this
  in `supported-events.ts`, keeping a hand-maintained mirror of the descriptor
  table's output kinds (it can't introspect them today; see the cleanup idea —
  export the supported set, or a predicate, from the codec).
- **Partial codecs vs `Codec` (resolved, `dc8ee25`).** `defineCodec` returns a
  `DefinedCodec`, which the transport consumes as a `Codec`. That assignability
  only held for a _full_ codec (every well-known input variant present) until the
  demo — the first transport-level consumer — exposed that a text-only codec's
  `DefinedCodec` over-promised the tool factories (`createToolResult` etc.
  returning `ToolResult<never>` ∉ `OpenAIInput`). Fixed by `DefinedCodecFactories`
  typing those factories present only when `TInput` carries the variant. **Open:**
  option C above removes the residual cast + phantom methods.

## Next step: tool calls (recommended), with a suggested order

The text path is complete end-to-end (codec + transport + demo). The headline
gap is **tool calls**, which the spike already de-risked (findings §A pinned the
function-call wire shape; §4 the `call_id` render pairing). Suggested sequencing,
smallest/most-foundational first:

1. **`decodeLifecycle` mid-stream-join repair (small, self-contained).** Lets a
   client that joins while a reply is streaming reconstruct the in-flight message
   item. Independent of tools; the demo can already trigger the gap (open a second
   tab mid-stream). A good warm-up that also hardens what's shipped.
2. **Server-side function calls (the big one).** Add `function_call` +
   `function_call_arguments` descriptor entries (discrete events per §A) and the
   reducer arms; build the backend agentic loop (execute the tool, append a
   `function_call_output` input, re-run `/responses`, continue) and surface tool
   items in the demo via the spike's `call_id`-pairing approach. The run does
   **not** suspend here — the agent executes the tool and continues the same run
   in place — so this needs no `suspend` outcome; the only run-end nuance over
   text is distinguishing `response.failed` / `response.incomplete` from
   `complete`, which is the general run-end-error-forwarding refinement (it
   applies to the text path already), not something tools uniquely require.
3. **Client-side tools + approvals (parity with the Vercel demo).** Add
   `ToolResult` / `ToolApprovalResponse` to `OpenAIInput` (clean now — the
   conditional factories from `dc8ee25` mean the codec only exposes the factories
   whose variants it declares), wire suspend/resume, and add the approval/tool-card
   UI. This is where the run genuinely suspends (the agent goes away awaiting a
   client tool result / approval and a later invocation resumes it), so it is
   where the full `openaiRunOutcome` mapper — including its `suspend` arm — earns
   its place. Brings the OpenAI demo to full feature parity.

Independent cleanups that can land any time: **option C** (codec passes its own
factory set — removes the `defineCodec` cast + phantom methods); exporting the
codec's supported output-event set so the demo filter stops mirroring the
descriptor table by hand; and **reverting the spike** before release.

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
