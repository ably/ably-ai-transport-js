# AIT-878 — Not-completed runs can break the conversation

_Investigation notes / design options. Working document, not committed code._

## The report

> If a run finishes unexpectedly or remains stuck in a streaming state, it can
> break the conversation. Open the demo in two tabs and send two concurrent
> requests that trigger tool calls. Because the tool calls may not be fully
> resolved, you can hit errors such as:
> `Tool result is missing for tool call toolu_01DnDaACic6djm8AAbeZpsDY.`

Lawrence's standup note framed the underlying question precisely:

> The general issue here is one of deciding how to create the context that gets
> fed into the LLM call; the problem is that if you include the contents of
> incomplete runs then you may end up combining two incomplete runs.

This document grounds that in the code, lays out representative scenarios,
records what already mitigates the bug (the `useChat` fork) and why it's
incomplete, and lands on an interim agent-side fix.

---

## How the prompt context is actually built today

When an agent serves a run it reconstructs the LLM prompt by walking the
conversation tree and flattening each node's projection into messages:

- `AgentView.loadConversation()` → `_collectConversation()`
  (`src/core/transport/agent-view.ts`) walks the parent chain via
  `walkAncestorChain()` and, **for every node in the chain**, concatenates
  `codec.getMessages(node.projection)`. The current run's projection is appended
  at the tail.
- The Vercel codec's `getMessages()` (`src/vercel/codec/reducer.ts`) simply
  returns `projection.messages` verbatim — the same `UIMessage[]` it produces
  for rendering.
- The demo route then does `convertToModelMessages(run.messages)` and hands the
  result to `streamText()` (`demo/.../api/chat/route.ts`).

Two facts matter:

1. **`walkAncestorChain` does not consult run state.** It includes every
   ancestor `RunNode` regardless of whether `node.state.status` is `complete`,
   `cancelled`, `error`, `suspended`, or still `active`
   (`RunNodeState` in `src/core/transport/types/tree.ts`).
2. **The render projection and the prompt projection are the same thing.** A
   run that called a client-side tool but never received the result has a
   projection containing an assistant message with a `dynamic-tool` part in an
   unresolved state (`input-available`, no `output-available`). That is correct
   and desirable for the **UI** (we want to show the spinner). It is invalid as
   an **LLM prompt**: `convertToModelMessages` emits a `tool_use` block with no
   matching `tool_result`, and Anthropic rejects it with exactly the reported
   error.

So the bug is structural, not a stray race: **any time an ancestor run in the
walked chain is not cleanly completed, its dangling tool call is fed verbatim
into the next LLM call.**

### Why a run is "incomplete" mid-conversation, and when it breaks

A run holds an unresolved tool call — an assistant `tool_use` with no matching
`tool_result` in its projection — for the whole gap between the call being
persisted to the channel and its result being persisted. That gap exists
regardless of where the tool runs: `streamText` → `toUIMessageStream()` emits
the `tool-input-available` chunk as soon as the model produces the call, and
`run.pipe()` publishes it to Ably immediately — _before_ the tool (client- or
server-side) has executed. The matching `tool-output-available` only lands once
the tool returns. The break is "an unresolved tool call reached the prompt", and
it is **agnostic to tool location**.

What varies is the **width of that gap**, and that is what governs how easily the
race reproduces — not whether the tool is client- or server-side:

- **Client-side tools** route the result back through a publish + continuation
  POST, so the run formally _suspends_ in between (`finishReason: 'tool-calls'`
  → `vercelRunOutcome` returns `suspend` → `run.suspend()`), re-activating when
  the continuation arrives. This is the only case that parks in the dangling
  state as part of _normal_ operation — but a snappy client tool closes the
  window almost as fast as an inline server call, so "client-side" is not by
  itself a reliable way to hit the race.
- **Server-side tools** resolve inline within `streamText`'s multi-step loop
  (`stopWhen: stepCountIs(10)`), so on a clean run the call and result land in
  the same projection and there is no dangling state. A long-running server tool
  still has a wide gap on the wire, though, so it breaks under interruption just
  like any other.

The reliable reproductions are the ones that make the gap large or unbounded,
independent of tool speed:

- a run **cancelled** mid-call (Scenario 4),
- a run that **never reaches run-end** — crash / timeout / aborted request
  (Scenario 3), which makes the gap effectively infinite,
- or, deliberately, a **long-running tool** (either side) to hand-widen it.

The two-tab concurrent repro in the ticket is, by contrast, timing-dependent: it
only fires if the second turn's context is assembled while the first run's tool
call is still unresolved, so if the tools resolve quickly the sends effectively
serialise and nothing reproduces. (Hence the ticket's hedged "_may_ not be fully
resolved" / "you _can_ encounter".)

---

## Representative scenarios

I find it useful to frame this around a few concrete cases that all reduce to
the same root cause but stress different parts of the system.

### Scenario 1 — Single client, message sent before a tool resolves (the simplest case)

This is the "similar case" raised in the brief, and I think it's the cleanest
one to reason about.

- User sends "What's the weather?". Run R calls `getLocation` and suspends with
  a dangling tool call.
- Instead of letting the location tool resolve, the user types a second message
  ("actually, never mind — tell me a joke").
- The client auto-parents the new input from the **visible branch tail**
  (`ClientSession._internalSend`, `autoParent = parentCodecMessageId` ≈ the last
  visible message). The visible tail is R's assistant bubble (the one showing
  the pending tool call), so the new input parents onto R.
- The agent serves the new run; `loadConversation` walks the chain, hits R,
  flattens its dangling tool call → "tool result is missing".

No concurrency, no two tabs — just a user who didn't wait. This tells me the
bug is fundamentally about **incomplete runs in the ancestor chain**, and the
two-tab reproduction is one way to manufacture them, not the essence.

### Scenario 2 — Two tabs, concurrent tool-calling requests (the reported repro)

- Both tabs start from the same completed tail.
- Tab A sends → run R_A calls a tool → R_A suspends (dangling tool call).
- Tab B has by now received R_A's streamed assistant content, so Tab B's
  visible tail is R_A's assistant bubble. Tab B sends → its input parents onto
  R_A → run R_B's context includes R_A's dangling tool call → error.

This is Scenario 1 with the "second message" coming from a different device.
The extra wrinkle is that **two runs can be in flight and interleave**, so you
can also end up with _both_ R_A and R_B incomplete and chained — "combining two
incomplete runs", as the standup note put it. Note this repro is timing-dependent
(see above): if R_A's tool resolves before Tab B's turn is assembled, the sends
serialise cleanly and nothing breaks — which is why it's a flaky way to trigger
the bug compared with cancel/crash/long-running-tool.

### Scenario 3 — Run stuck / agent died (never reaches run-end)

- Run R calls a tool and suspends — or the agent process crashes / the request
  times out after streaming a tool call but before `run.suspend()`/`run.end()`.
- R is now permanently incomplete (suspended-forever, or active-forever with no
  terminal event).
- The next turn on the branch parents onto R and inherits the dangling tool
  call. Unlike Scenarios 1–2 this never self-heals, because nothing will ever
  resolve R's tool call.

This is the "remains stuck in a streaming state" half of the report. It matters
because any fix that relies on R _eventually completing_ won't save this case —
we need the prompt builder to be robust to runs that never complete.

### Scenario 4 — Cancellation mid-tool-call

- Run R streams a tool call; the user (or another client) cancels it. R ends
  with reason `cancelled`, its projection still holding the unresolved tool
  call.
- Next turn parents onto R → dangling tool call in context.

Same shape; the run _is_ terminal, just terminal-without-resolution.

**Common root cause across all four:** the prompt builder flattens ancestor run
projections that contain tool calls with no matching results, and the model
provider rejects the resulting message sequence. Whether the run is `active`,
`suspended`, `cancelled`, or `error` is incidental — what they share is
"reachable in the ancestor chain AND not cleanly resolved".

---

## What already mitigates this — the `useChat` fork, and why it's not enough

A partial fix already exists, and finding it reframed the whole investigation.
The `useChat` adapter (`ChatTransport`) has **fork-on-unresolved-tool** logic
(`src/vercel/transport/chat-transport.ts`, added 2026-04-21 in `fa01266c` —
**before** this issue was filed). On a fresh user submit, if the immediately
preceding message (`messages.at(-2)`) is an assistant with an unresolved tool
call (`hasUnresolvedToolCall` → states `input-streaming` / `input-available` /
`approval-requested`) and that assistant is in the tree, it **forks the new
message off that assistant**: `parent` = the message _before_ the assistant,
`forkOf` = the assistant. So the dangling run becomes a dormant **sibling
branch**, off the new message's ancestor chain.

**Confirmed working (single-tab `useChat`).** With `getWeather` made to sleep,
sending a follow-up while the call is pending yields `run.messages` = just the
two user messages — the dangling call is structurally absent, no error. The
bubble stays visible in the UI, because the fork is non-destructive _and_ the
new input node and the dangling run node are different kinds, so the View's
sibling-collapse (same-kind only) hides neither — both render. (Note this is a
**traversal difference**, not a codec render/prompt split: the client View walks
`visibleNodes` — reachable nodes incl. siblings — while the agent walks the
ancestor chain only; both call the same `getMessages`. After a fork the dangling
run is visible-but-not-ancestor.)

**Why it's not enough — three gaps, all observed:**

1. **Scope: `useChat` only.** The logic lives in `ChatTransport`. The raw
   `ClientSession` / `View.send` path (e.g. the `use-client-session` demo, same
   Vercel codec) has no fork. **Deterministic break confirmed there:** same
   sleep-`getWeather` test, `run.messages` contained the assistant `getWeather`
   part in `input-available` with no result → `AI_MissingToolResultsError` on
   that exact `toolCallId`. This is the clean, race-free reproduction and the
   right regression target.
2. **Narrow trigger.** The gate only inspects the _immediate_ predecessor
   (`at(-2)`) and only fires for _live unresolved-tool_ states. Once a run ends
   in **error** (or the dangling call is buried deeper than `at(-2)`), the
   predecessor no longer looks like an unresolved tool call, the fork doesn't
   fire, and the new turn chains onto the broken tail — inheriting a dangling
   ancestor the gate never looked deep enough to see. This is the **cascade** in
   the reporter's screenshot: one run errors, then every subsequent turn
   (`in paris?`, `in milan?`) inherits the buried dangling call and also errors.
3. **The preamble race — and it's fundamentally unfixable client-side.** The
   model streams a conversational preamble ("Let me grab your location first…")
   _before_ it streams the tool call. During that window the assistant is a
   plain **text-only** message — `hasUnresolvedToolCall` is false — so a send
   that lands there parents onto it _without_ forking. The tool call streams in
   a beat later, leaving the assistant dangling with the new turn already
   beneath it. The fork can't fork off a tool call that hasn't been produced
   yet, so no client-side gate, however it reads its inputs, can catch this: at
   send time the information does not exist on the channel.

   **Instrumentation confirmed this is the dominant mechanism** (temporary
   logging in `sendMessages`). At the breaking send, _both_ the gate's source
   (`opts.messages.at(-2)`) _and_ the live `viewTail` showed the preceding
   assistant with **empty `toolParts`** — text-only in both. That rules out an
   earlier hypothesis that the break was a useChat-state-vs-tree **sync-lag**
   skew (which would have shown the tool call in `viewTail` but not in
   `opts.messages`); the call simply wasn't anywhere yet. (Sync-lag is plausible
   in principle and may contribute across tabs, but it is _not_ what we
   observed.)

**A `convertToModelMessages` nuance worth recording.** It **drops** tool parts in
`input-streaming` state (`ai@6` `index.mjs`: `if (part.state !== "input-streaming")`
before emitting a `tool-call`), and emits a `tool_use` for every other state. So
a dangling call frozen at `input-streaming` (model still streaming the tool
input when the agent's history snapshot froze it) produces **no error but no
fidelity** — the model never learns the tool was called; only `input-available`
and later emit a `tool_use` and trigger the hard error. Same structural bug, two
manifestations depending on which stream phase the reconstructing agent caught.

**Forensics caveat.** The reporter's June channel isn't ours to inspect, so we
can't pull its exact failing messages. We don't need to: the error _class_ is
fixed by the ticket text ("Tool result is missing…"), and the root cause is
confirmed independently by the deterministic `use-client-session` dump above.
Pinning the exact `toolCallId` in that screenshot adds nothing a class-level fix
depends on.

### Reproducing it

**Why a client-side tool makes it consistent (the amplifier).** A client tool
(`getLocation`) **suspends** the run, so the dangling assistant sits unresolved
for the _entire_ client round-trip (publish result → continuation POST → resume)
— seconds, not the sub-second gap a server tool would dangle for. And the client
tool _guarantees a continuation_: the run resumes, re-walking the whole chain.
Tracing a confirmed two-tab break (full wire log in the working notes):

- The dangling call originates from the **first** send's run (tab A's `A1`,
  whose `getLocation` is never resolved). The **second** send's input parents
  onto `A1` (preamble race), so `A1` is on the second run's ancestor chain.
- The error fired on the second run's **continuation (resume)**, not its initial
  inference. Both walk through `A1`, but the initial inference _raced_ `A1`'s
  tool-call materialising in history and happened to win (it reconstructed `A1`
  as text-only); the resume, seconds later, reliably saw the materialised
  dangling call. So the continuation is the _reliable trigger_, not the cause.

So the combination — preamble race to get parented on, suspend to keep it
dangling, continuation to re-walk late — is what turns a tight timing window
into a "fairly consistent" repro. (This is also why the fix must run on **every**
prompt build, initial _and_ each resume.)

**A deterministic repro for the `useChat` path** widens the _parenting_ window,
not the dangling one. Slowing the client tool's execution is the wrong lever — it
widens the time the assistant is _visibly_ `input-available`, which makes the
fork _fire_ (safe), not miss. Instead widen the **preamble→tool-call** gap:

- Use the **mock model** (`api/chat/mock-model.ts`): stream a chunk of preamble
  text, `await sleep(Ns)`, _then_ emit the `getLocation` call. Any send during
  that N-second text-only window deterministically parents-without-forking.
- The error still surfaces with a mock model: `AI_MissingToolResultsError` is
  thrown by the AI SDK during **prompt standardisation** (the message →
  language-model conversion validates tool-call/result pairing), _before_ the
  model's `doStream` is called — so it is provider-independent. The mock model
  only needs to _emit_ the dangling tool call; its `doStream` is never reached.

The simplest race-free repro remains the `use-client-session` path (no fork at
all), which is the regression target below.

---

## The hard constraint, and why this is really two problems

Before weighing fixes it's worth being precise about what the model provider
will and won't accept, because it bounds everything.

**Provider message formats require every `tool_use` to be immediately followed
by its matching `tool_result`, before any further turn.** (Anthropic and OpenAI
both enforce adjacency; `convertToModelMessages` produces the sequence and the
provider rejects a `tool_use` with no following `tool_result` — exactly the
reported error.) So you cannot hand the provider "assistant called a tool, no
result, then the user said something". _Something_ must occupy the result slot.

That constraint splits AIT-878 into two genuinely different problems that happen
to surface as the same error:

1. **The validity bug.** A prompt is assembled that contains an unresolved tool
   call, and the provider rejects it, breaking the conversation — potentially
   _forever_ (Scenario 3). This is a real bug and it is fixable.
2. **The interrupt UX.** A user deliberately speaks to a _live_ pending tool
   call ("why are you mining bitcoins, I asked for the weather"). Here the tool
   may still be executing, so the SDK has no authority to cancel it (only the
   agent that owns the run does), and no generic, faithful way to represent
   "treat this call as interrupted by my question" to the model. This is **not
   generically solvable** at the transport layer (see below) and is out of scope
   for the bug fix.

### The axis that actually distinguishes them: will a result ever arrive?

Not _where_ the run sits in the tree (the new turn always parents onto the run
with the pending call, in both problems) but whether the call is still **live**
or already **dead**:

- **Terminal run, unresolved call** (`cancelled` / `error`, and in principle a
  mis-`complete`d run): provably dead — terminal runs don't resume, so no result
  is ever coming. Safe to treat as abandoned.
- **Non-terminal run, unresolved call** (`active` / `suspended`): could be
  genuinely live _or_ silently dead (a crashed/stuck run looks `active` forever
  and is indistinguishable from a slow one). The transport cannot tell which.

The interrupt case (problem 2) lives in the non-terminal bucket, which is
exactly the bucket the transport can't reason about — so the irreducible hard
part and the unsolvable-generically part are the same part.

### Shapes for making the prompt safe

Four shapes, given an ancestor run holds an unresolved tool call:

- **Synthesise a tool result** (`output-available` with a placeholder string, or
  `output-error`). _Valid_ — tool **results** are not schema-constrained (only
  tool **inputs** are; our codec emits untyped `dynamic-tool` parts, and the
  `convertToModelMessages` path doesn't validate output against any
  `outputSchema` — that check lives only in the opt-in `validateUIMessages` and
  only for statically-typed `tool-*` parts). But it's a poor fix: it fabricates
  a result the tool never produced and gambles on model behaviour (a placeholder
  may be taken at face value; an error may trigger a retry). **Rejected.**
- **Drop the offending run, decided by the codec.** The codec reports whether a
  projection is prompt-safe; the transport omits an ancestor run the codec
  flags. Coarse (drops the whole run, not just the dangling part) but precise
  about _which_ runs (only those with an actual unresolved call), needs no
  fabrication, and keeps the codec-specific knowledge behind a generic
  predicate. **This is what we implemented — see below.**
- **Part-level repair in the codec** (drop just the unresolved `dynamic-tool`
  parts, or stub them). Finer-grained — it keeps an abandoned run's text — but
  needs a prompt-vs-render message _transform_ in the codec, not just a
  predicate. **Deferred;** the drop-whole-run predicate is the smaller first step.
- **Structural — re-parent new sends to the last _completed_ message**
  (`ClientSession._internalSend`) and/or guard agent-side. Attacks "combining
  two incomplete runs" at the source, but the client often doesn't know
  completion state at send time (that's the race), so it can't be airtight, and
  it raises the same product question as the interrupt UX (sibling branch?
  supersede?). **Part of the real fix, not this.**

---

## The fix (implemented): a codec prompt-safety predicate

The `useChat` fork is a _client-side, codec-aware_ mitigation with the holes
above (scope, narrow trigger, the unfixable-client-side preamble race). The
complement it's missing is an _agent-side backstop_: the agent is the one actor
that reconstructs the fully-reconciled channel, so it can refuse to put a
dangling ancestor run into the prompt **regardless of which client produced the
chain, how the parent header got set, or how deep the dangling run is buried**.
The two are complementary — the fork preserves the dangling run as a dormant
branch when it can; the backstop catches everything the fork misses (and it
covers the raw `ClientSession` path too).

### Two rejected attempts first (run state is the wrong signal)

Both were committed then reverted (visible in history); the dead ends are the
useful part:

1. **Run-state filter `{suspended, cancelled, error}`.** Drop ancestor runs in
   those states. It **missed the literal getWeather case**: a server-side tool
   runs inline in `streamText`, so the run stays **`active`** (it never
   suspends) with a dangling call — and `active` was kept.
2. **Run-state filter `≠ complete`** (drop `active` too). Caught the server-tool
   case but was too blunt: an `active` ancestor might be one harmlessly
   streaming text we'd want in the next prompt (or a completed run whose
   `run-end` wasn't folded yet), or it might be the one holding the dangling
   call — run state can't tell which, so dropping every `active` run discarded
   healthy in-flight content and **broke the `agent ≡ client` cross-engine
   invariant** for any incomplete run, forcing churn across ~13 tests.

The lesson: **run state is a poor proxy for "has a dangling tool call."** The
real signal is the projection's _content_, which only the codec can read.

### The predicate

- **`Codec.isPromptSafe?(projection): boolean`** — a new, **optional** method on
  the generic codec contract (`src/core/codec/types.ts`, wired through
  `defineCodec`). Returns whether a projection can be flattened into a prompt
  without producing a dangling tool call. Optional ⇒ a codec that omits it has
  every projection treated as safe, so it is **non-breaking**.
- **`AgentView._collectConversation`** omits an ancestor run when
  `this._codec.isPromptSafe?.(node.projection) === false` — current run exempt
  (`runId`), and it runs on every prompt build (initial inference _and_ each
  continuation/resume), so a late re-walk (the reliable trigger we observed)
  can't reintroduce the run. The walk continues past a dropped run, so the input
  nodes around it survive.
- **Two-layer split preserved.** The generic name carries no tool vocabulary and
  the generic layer learns nothing about `dynamic-tool` parts — the codec owns
  the verdict. (`isPromptSafe`, deliberately, not `hasUnresolvedToolCall`.)
- **Vercel impl** (`src/vercel/codec/reducer.ts`): a projection is unsafe iff any
  message holds an unresolved tool part — `input-streaming` / `input-available` /
  `approval-requested` — via the shared `isUnresolvedToolPart` /
  `UNRESOLVED_TOOL_STATES` in `tool-part.ts`. `input-streaming` is included
  deliberately: rather than rely on `convertToModelMessages` dropping a
  still-streaming part, we treat it as unresolved at source. That set is the
  **single source of truth** shared with the client-side fork gate
  (`hasUnresolvedToolCall`), so the two definitions cannot drift.

### Why this one

It drops a run **only when it genuinely carries a dangling call, regardless of
run state** — so it catches the `active` server-tool case _and_ keeps healthy
`active`/in-flight runs, which means the `agent ≡ client` equivalence still holds
for tool-free runs (no test churn — existing tests use a codec without
`isPromptSafe`, so they are unaffected). It's checked on every prompt build, so
a late re-walk can't reintroduce a run.

**What it gives up** (the residue with no clean generic answer): it's coarser
than part-level repair — a run dropped this way loses any text it produced, and
the interrupt/bitcoins turn still vanishes from the prompt (the model can't
explain a call it can no longer see). And a `complete`-but-dangling run (an agent
bug — ended without resolving a call) slips through, by design.

**Tests:** `tool-part.test.ts` covers `isUnresolvedToolPart` across every tool
state (unresolved vs resolved); `reducer.test.ts` covers `isPromptSafe`
(text/empty safe; each unresolved state unsafe; resolved safe); and
`agent-session.test.ts` covers the filter — unsafe ancestor dropped, safe-but-
`active` ancestor kept, current run kept when its own projection is unsafe, and
an unsafe run sandwiched between healthy turns (only it is dropped, the walk
continues).

---

## What's still deferred

The implemented fix closes the **validity bug** (problem 1). It does not address
deliberately interacting with a pending tool call (problem 2), which stays
**surface-and-delegate, not repair** because the authority and richer policy live
outside the generic transport:

- **Part-level fidelity.** Drop only the dangling _parts_ (keeping an abandoned
  run's text) rather than the whole run — a codec prompt-vs-render message
  transform. The predicate is the smaller first step.
- **Make incompleteness controllable by the agent** — let the app pick its policy
  per unresolved call (drop, error-stub, wait, re-prompt, or cancel the real work
  via its own mechanism). Policy belongs with the actor that has authority over
  the in-flight work.
- **Support interruption properly** — cancellable tools plus agent-crafted
  guidance to the model ("the user interrupted; address their message"). This is
  the "interruptable tool call" shape; invasive and per-tool, explicitly _not_
  something the transport can provide transparently.
- **Decide the conversation topology** for "user sends while a tool is pending"
  (re-parent to last completed message? sibling branch? supersede?). A product
  decision, and the one that most directly answers the standup framing about
  "combining two incomplete runs".

### Open questions / status

- **Drop-whole-run vs part-level repair.** The predicate drops the whole run;
  part-level repair would keep its non-tool content. Deferred — revisit if the
  lost context proves to matter.
- **Render vs prompt divergence.** The fix formalises that the agent's prompt is
  _not_ the rendered history (the UI still shows the pending call; the prompt
  omits its run). The right call — they have different correctness requirements —
  but a divergence the codebase now carries deliberately.
- **End-to-end regression still worth adding.** The deterministic
  `use-client-session` sleep-`getWeather` case (assert `run.messages` no longer
  carries the dangling call and `convertToModelMessages` stops throwing), plus an
  explicit adjacent-user-turns check (dropping a middle run leaves two user turns
  adjacent; the AI SDK coalesces them, but worth asserting end-to-end). The
  `useChat` race need not be reproduced — the agent-side predicate sits below it.
