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
- latest — `toResponsesInput` model-input helper + this build log.

The codec **round-trips text both directions** (user prompt in, streamed
assistant reply out) at the codec level. Each increment was reviewed with
`/code-review-all` (13 concerns) and is green: typecheck, lint, full unit suite,
build, and codec-level integration roundtrips over real Ably. `src/openai/codec`
is at 100% line coverage.

## What exists today

- **Entry point** `@ably/ai-transport/openai` → `ResponsesCodec` (+ types
  `OpenAIInput`/`OpenAIOutput`/`OpenAIItem`/`OpenAITurn`/`OpenAIProjection`) and
  `toResponsesInput`. `openai` is an optional peer dependency.
- **Output**: response lifecycle + `output_text` streaming + the `output_item`
  message envelope + `content_part` boundary → folded into an `OpenAITurn`.
- **Input**: the `user-message` `batch` fans a turn's `input_text` content parts
  out into one `ai-input` event each; the reducer merges them by codec-message-id.
- **`toResponsesInput(turns)`**: flattens the conversation into the `/responses`
  `input` array (near-identity — see the cast note below).

## Deferred — all marked `TODO(AIT-742)` in code

- **`decodeLifecycle`** (mid-stream-join repair): synthesise the
  `output_item.added` message-item lead-in when a text stream starts mid-flight,
  so a client joining mid-stream / hydrating from history reconstructs the item.
  The full-stream path works without it; this is the next codec-correctness item.
- **Function calls / server-side tools**: descriptor entries + reducer arms for
  `function_call` + `function_call_arguments`, and the backend agentic loop.
- **Client-side tools + approvals** (suspend/resume), and an `openaiRunOutcome`
  mapper (premature until then — for text-only the outcome is just complete/error).
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
  `run.pipe`** rather than the codec silently dropping them.

## Next step: a text-only demo (recommended next task)

Goal: an OpenAI Responses demo proving the codec end-to-end against real OpenAI,
mirroring `demo/vercel/react/use-client-session/` but text-only (no tools yet —
branching / regenerate / history / multi-client all come free via the generic
hooks). Suggested location: `demo/openai/react/use-client-session/`.

Architecture facts (verified against the code):

- **Backend** uses the **generic** `createAgentSession({ client, channelName,
codec: ResponsesCodec })` from `@ably/ai-transport` (core exposes generic
  `createAgentSession`/`createClientSession` that take a `codec`; the Vercel ones
  are just pre-bound wrappers — no OpenAI transport layer is needed). Loop:
  `run.start()` → `run.loadConversation()` (returns `OpenAITurn[]`) →
  `toResponsesInput(...)` → `openai.responses.create({ model, input, stream: true })`
  → wrap the async iterable as a `ReadableStream<ResponseStreamEvent>` →
  **filter to the codec's supported event types (log dropped types with a
  `TODO(AIT-742)`)** → `run.pipe(stream)` → `run.end()` on completion / error.
  Use a **non-reasoning model** (e.g. `gpt-4.1`) so reasoning events don't appear.
- **Frontend** uses the **generic** `createSessionHooks<OpenAIInput, OpenAIOutput,
OpenAIProjection, OpenAITurn>()` from `@ably/ai-transport/react`, passing
  `ResponsesCodec`. Adapt `message-list`/`message-bubble` to render
  `OpenAITurn.items` (message items → `output_text` content parts) instead of
  Vercel's `UIMessage.parts`.
- Provide a **mock model** (fixture `ResponseStreamEvent`s, like the spike
  fixtures) for deterministic Playwright e2e; gate the real model behind
  `OPENAI_API_KEY`.

Study first: `demo/vercel/react/use-client-session/src/app/{api/chat/route.ts,
providers.tsx,components/*}`, `src/openai/codec/`, `src/openai/to-responses-input.ts`,
and the core session/run types (`src/core/transport/types/{agent,run}.ts`).
Follow `CLAUDE.md`'s workflow rules: run typecheck/lint/format/test after changes,
review with `/code-review-all`, and never commit without approval.
