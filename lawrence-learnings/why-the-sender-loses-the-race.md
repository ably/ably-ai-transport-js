# Claude's theory of why the sender always seems to lose the race

_Context: AIT-843, multi-tab (same `clientId`) client-side tool calls. Two tabs
both execute a client-side tool (e.g. `getLocation`) and both auto-submit a
continuation. We observed that the tab which **sent the original prompt** is
consistently the one whose `deriveContinuationInputs` returns `[]` (the empty
path — the log Lawrence added fires on the sender every time, not at random)._

## The confirmed fact (not theory)

Tool **execution** is symmetric between the two tabs. `useClientTools` is driven
by `useView` (`demo/.../chat.tsx:105`, passed at `:109`) — i.e. the **tree
projection**, which updates in real-time from the channel on _both_ tabs and is
**not** gated by `useMessageSync`. So both tabs see the `input-available` tool
call at roughly the same moment and both run the tool at roughly the same time.

So the asymmetry is NOT in who executes first. It's downstream, in who
**publishes the `tool-result` first**.

## The theory (why the sender publishes second)

The continuation is not triggered off the view — it's triggered off useChat's
**overlay**, via `sendAutomaticallyWhen` (`lastAssistantMessageIsCompleteWith
ToolCalls`). `addToolResult` mutates the overlay, and that path is asymmetric:

- **Observer tab** (never sent): `streaming = false` throughout, `useMessageSync`
  ungated, useChat sits at `status: 'ready'`. The instant `addToolResult` fires,
  `sendAutomaticallyWhen` evaluates and dispatches the continuation
  **immediately** → it publishes its `tool-result` first.

- **Sender tab**: has an active own-run stream for the original prompt, so
  `streaming = true` and useChat is mid-request (`submitted` / `streaming`).
  useChat serializes — it will not dispatch the auto-continuation until that
  request fully settles to `ready`. That requires: the run stream closes on the
  `tool-calls` finish → `streaming` flips false → `useMessageSync` ungates and
  reconciles the overlay against the tree → _only then_ does
  `sendAutomaticallyWhen` fire the sender's continuation.

Those extra hops are a consistent head-start for the observer. By the time the
sender computes `deriveContinuationInputs`, the observer's `tool-result` has
already echoed onto the channel (and the sender's own ungate-reconcile may have
pulled the resolved state straight into its overlay) → tree already resolved →
empty path → the log fires. **Every time**, because the asymmetry is structural,
not timing-jitter.

## Why it matters (it's not just a curiosity)

1. **It's the AIT-843 bug class, demonstrated.** The winner is decided by
   _incidental client state_ — "do I happen to have an active own-run stream
   right now?" — not by anything principled. That is exactly "shared state
   treated as private/authoritative."
2. **The sting:** the consistent loser is the **sender** — the foreground tab the
   user is actually looking at. So the worst symptom (the no-op infinite loop, or
   the original `error` flicker) reliably lands on the active tab, not a random
   one. That's why it feels ever-present rather than rare.
3. **It's a good signal for the chosen direction.** Under always-emit +
   symmetric observer streams (option A, tolerate-and-dedup), "who publishes
   first" stops mattering. If this asymmetry _dissolves_ under that design, that's
   confirmation we removed the right dependency.

## Corollary: why the race-loss is deterministic but the infinite loop isn't

If the sender _deterministically_ loses the publish race, why is the no-op's
"Maximum update depth exceeded" crash only _intermittent_? Because they're two
different races, and only the first is structural.

The continuation has two stages, and the sender sees them at different times:

- **Stage A — the `tool-result` lands in the tree** (resolves the tool part).
  This is what makes `deriveContinuationInputs` return `[]`. The sender always
  loses race 1, so Stage A is _always_ done by the time it evaluates → it
  _always_ takes the no-op path. **Deterministic.**
- **Stage B — the continuation _response_ lands in the overlay** (a follow-up
  assistant message appended via `useMessageSync`). This is the _only_ thing that
  flips `sendAutomaticallyWhen` false and stops the loop.

The gap **A→B is the agent's continuation inference time** (the observer
published the result, but the LLM is still generating the reply). Where the
sender starts evaluating relative to that gap decides the outcome:

- **Evaluates after B** (observer already completed the continuation — fast/short
  reply): last assistant is now the text response, predicate is _false_,
  `sendAutomaticallyWhen` never fires → **no loop**. This is the "worked once".
- **Evaluates inside the A→B gap** (result resolved, reply not back yet):
  predicate _true_ but nothing to publish → no-op → ready → still true → loop,
  spinning until B lands. If B exceeds React's ~50-update budget within one
  update cycle → **"Maximum update depth exceeded."**

So race 1's determinism only guarantees the sender _enters_ the no-op path.
Whether it loops depends on race 2 — the variable A→B latency (agent/LLM time,
network, plus React's update-depth counter being sensitive to whether resubmits
land in one cycle or spread across ticks). Variable input → intermittent outcome.

**Uncomfortable corollary:** the "worked" turns weren't the code working — they
were the observer's continuation happening to finish before the sender looked.
The no-op is broken on _every_ turn; you only _see_ the break when the agent is
slow enough to leave the A→B gap open.

## How to confirm cheaply (if desired)

Log `status` / `streaming` (or a `performance.now()` for execute-vs-continuation)
at the top of the continuation branch on each tab. Expectation: the sender enters
its continuation measurably later, right after its `streaming → false`
transition. Given it lines up cleanly with the code, treat it as understood
unless it stops matching the model.

## Status

Theory, grounded in the code paths above but not yet runtime-confirmed with
timing logs. Authored 2026-06-19.
