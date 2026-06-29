# OpenAI codec — Phase 0 spike brief

_Actionable brief for the de-risking spike. The **why** lives in
`openai-codec-recommendations.md` (referenced as §N below); this doc is the
**what to build and what to prove**. Disposable/scratch code — not the real
codec or demo._

## Goal

Cheaply falsify two things before committing to the build:

1. **No core API change.** The Responses target can be expressed within the
   existing `Codec` / transport contract (§7) — no change to `src/core`.
2. **The items-based `TMessage` works** — it renders cleanly and is losslessly
   convertible to model input (§5).

If either fails, the spike's output is a precise description of what strains and
what (if anything) `src/core` would need — surfaced for review, not changed
unilaterally (§7, and the "only change the API if really necessary" rule).

## Fixed decisions (do not re-litigate in the spike)

These are settled in the recommendations doc; the spike assumes them:

- **Responses-first, raw Responses stream** — not the Agents SDK (decisions #1/#7).
- **`TOutput` = OpenAI's `ResponseStreamEvent` union** (pass-through), handling
  the subset below initially (§5).
- **`TMessage` = one turn's OpenAI items** (`ResponseOutputItem`-grounded), roles
  `user`/`assistant`, **per-turn = one message** (decision #2, §5).
- **`fold` = the reduction**: mirror or directly call the SDK's `accumulateResponse`
  (`openai/lib/responses/ResponseAccumulator`) to accumulate items (§2).
- **`toResponsesInput` ≈ identity**: concatenate each turn's items; nothing to
  split (§5).
- **Tool call + result are separate items** linked by `call_id`; pairing for
  display is a **render-time helper**, not a `TMessage` type (§5).
- **Stateless usage** — full conversation per `/responses` call (§1).
- **Codec-message-id is the message boundary** (one per run; `suspend`/`resume`
  reuses the same `runId`).
- **Run lifecycle is agent-driven** (`run.start`/`end`), separate from the codec
  stream: `response.created`/`completed` feed an `openaiRunOutcome`, not run
  events. The `stream(...)` vs `event(...)` descriptor split and the coarse wire
  `status` (`streaming`/`complete`/`cancelled`) follow §2 of the recommendations.

## What to build (minimal scratch)

- A scratch codec via `defineCodec`: reducer (`init`/`fold`/`getMessages`) plus
  output/input descriptor tables for the **subset** only —
  `response.created`/`in_progress`/`completed`/`failed`/`incomplete` + `error`
  (lifecycle), `output_text.delta`/`.done`, `function_call_arguments.delta`/`.done`,
  `output_item.added`/`.done`, `content_part.added`/`.done`.
- `fold` accumulating into a projection of OpenAI items (mirror/import
  `accumulateResponse`).
- A tiny `toResponsesInput(messages): ResponseInputItem[]`.
- An `openaiRunOutcome` mapper (the `vercelRunOutcome` analogue): `completed`
  with no pending tool → `complete`; pending client tool/approval → `suspend`;
  `response.failed` / stream-`error` / throw → `error`; abort → `cancelled` —
  feeding `run.end` / `run.suspend`.
- A harness feeding a **fixture Responses event stream** (no live API key, no LLM
  calls) through the decode path; assert `getMessages()` yields the expected items.
- A second fixture exercising a **multi-`/responses`-call run** (call → tool →
  call again) to prove it folds into one message.

## Hypotheses to falsify (the checklist)

1. **String-append fits.** `output_text.delta` and `function_call_arguments.delta`
   accumulate under the codec's string-only `stream` model (`StreamPayload.data: string`).
2. **One message per run holds.** Multiple `/responses` calls in a run accumulate
   into a single `TMessage`; the codec-message-id is a clean boundary.
3. **Concurrent tool-call streams compose.** Multiple `function_call`s in one
   response (each its own `item_id` + arg-delta stream) reduce correctly under the
   single-`deltaField` stream model. _(The first real multi-stream-per-message
   test — most likely place to strain.)_
4. **Items render cleanly** and the `call_id` pairing helper is pleasant to use.
5. **`toResponsesInput` is genuinely near-identity** and round-trips losslessly
   (items out == items back in, modulo the appended tool-result items).
6. **A client-side `ToolResult` appends to the suspended run on resume** (same
   `runId`), landing in the same message as the call. _(Can be a thin simulation —
   publish a `ToolResult` input and assert it folds onto the right turn.)_
7. **The descriptor split holds.** The nested `output_item` > `content_part` >
   delta boundaries map cleanly onto `stream(...)` families (carrying the coarse
   `streaming`/`complete` status) vs `event(...)` discrete descriptors, and the
   wire status behaves sensibly across a run's multiple `/responses` calls.
8. **Errors land on run-end.** A simulated `response.failed` / stream-`error`
   routes via `openaiRunOutcome` → `run.end({ reason: 'error' })` (the
   codec-agnostic baseline); the reducer stays out of error handling; a `refusal`
   folds as content, not an error.

## Out of scope (defer to later phases)

Client-side tools end-to-end, tool approvals/HITL, reasoning/refusals/annotations,
hosted tools, multi-agent / Agents SDK, the real use-client-session-style demo
(§8 Phases 1–4).

## How to run it

- **Fresh Claude session rooted in this worktree** (loads the local code-review
  skills), after decisions #1/#2/#7 are locked.
- Re-clone the OpenAI SDKs for reference (or rely on the recommendations doc):
  `git clone --depth 1 https://github.com/openai/openai-node` (types in
  `src/resources/responses/responses.ts`; reducer in
  `src/lib/responses/ResponseAccumulator.ts`).
- Follow the repo workflow rules: `pnpm run typecheck` / `lint` / `format:check`
  and `pnpm test` after changes; `/code-review-all` before presenting; never
  commit without approval.

## Output

A short findings note: each hypothesis confirmed/refuted with evidence, and — if
any strained — a precise description of what `src/core` would need and why, for
review before any core change.
