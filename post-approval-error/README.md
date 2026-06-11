# Post-approval follow-up error (AIT-870 generateText spike)

A bug found while testing the AIT-870 `generateText()` spike (Option A). Captured
here to return to later — **not yet fixed**, and the spike is paused.

## What we were testing

The `generateText()` mode of the `use-chat` demo
(`DEMO_GENERATION_MODE=complete`), exercising the approval-gated tool flow:

1. Send **"what's the weather forecast for London?"** → the model calls
   `getWeatherForecast`, which is gated on approval (`needsApproval`), so the run
   **suspends** at an approval request.
2. **Approve** → the client publishes a `tool-approval-response`, the run
   **resumes**, and the forecast comes back. So far this works from the user's
   point of view.
3. Send any **follow-up message** (e.g. "hello") → the agent errors. Its
   `ai-run-end` carries `run-reason: error`, the client shows no response, and
   **every subsequent message** errors the same way (the channel looks stuck).

The underlying exception (logged in the agent route) is an Anthropic 400:

```
messages.1.content.4: `tool_use` ids must be unique
```

i.e. `convertToModelMessages(run.messages)` on the follow-up turn produced a
conversation with the same `tool_use` id twice.

## The example files

Both are `console.dir(run.messages)` from the agent handling the **follow-up
("hello") turn**, after the forecast/approval run completed:

- [`complete/run-messages`](./complete/run-messages) — generate mode (`DEMO_GENERATION_MODE=complete`). **Broken.**
- [`stream/run-messages`](./stream/run-messages) — stream mode (default `streamText`). **Works.**

Both show the **same** corruption: the two assistant messages of the
forecast run appear **twice** (`[A, B, A, B]`, with identical message ids). The
only difference is the tool part's state:

- **stream**: `state: 'output-available'` with the real forecast `output` (the
  tool executed).
- **generate**: `state: 'approval-responded'`, **no output** (the tool's result
  never reached the wire).

## Root cause — two distinct bugs

### Bug 1 (core, affects both modes): `loadConversation` double-folds a multi-invocation run

The approval flow makes one run emit **two** messages under the same `run-id`
(the suspended assistant `A` from invocation 1, the resumed forecast text `B`
from the resume). On the follow-up turn, the branch-chain walk in
`src/core/transport/load-conversation.ts` (~lines 332-345) folds **per chain
node**, and `foldRunMessages(runId)` folds the **entire** run each time. The
chain passes through both `A` and `B` (same run), so the whole run `[A, B]` is
emitted **twice** → `[A, B, A, B]`. The existing guard (the `meta.runId === runId`
skip) only covers the _current_ run's continuation, not a _prior_ multi-message
run the branch passes through.

`convertToModelMessages` then emits the `getWeatherForecast` `tool_use` twice.
This is mode-independent — it is latent in stream mode too (see the stream
example file), tolerated there only because those duplicate tool calls each
carry a `tool_result`.

**Fix direction:** dedupe by `run-id` in the chain walk — fold each distinct
prior run once (a run's projection already contains all its messages).

### Bug 2 (the spike's converter, generate-specific): approval-executed tool results are dropped

On an approval resume, `generateText` executes the approved tool **before** its
step loop and pushes the result into `result.response.messages`, **not** into
`result.steps` (see `node_modules/ai/dist/index.mjs`, the `collectToolApprovals`
→ `executeTools` path). Our converter (`src/vercel/generate-text.ts`) only walks
`result.steps`, so it never emits the `tool-output-available` — the tool call
stays `approval-responded` with no output on the wire.
`streamText().toUIMessageStream()` _does_ include that result, which is why the
stream example shows `output-available`.

**Fix direction:** the converter must emit approval-executed tool results too
(read `result.response.messages` / `result.toolResults`, not just
`result.steps`).

## Why generate errors but stream doesn't

Bug 1's duplication is present in both modes. But:

- **stream**: each duplicate `tool_use` has a matching `tool_result` → Anthropic
  tolerates it → works.
- **generate**: Bug 2 means the duplicate `tool_use` has **no** `tool_result` →
  Anthropic rejects with "ids must be unique".

Fixing either bug would likely stop the error, but both are real: Bug 1 is a
genuine pre-existing core correctness bug (independent of the spike); Bug 2 is a
gap in the spike's converter.
