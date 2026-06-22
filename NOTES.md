# AIT-843 — multi-tab client-side tool-call "empty inputs" flicker

_Working notes (scratch). Investigation captured before context loss._
_Line numbers re-anchored against `26d5a46c` (origin/main, incl. AIT-879)._

## START HERE (handoff — last updated 2026-06-22)

This file is the single source of truth; read it top-to-bottom, but this section
orients you. The rest of the file is a CHRONOLOGICAL investigation log — later
sections supersede earlier ones.

**The bug:** two browser tabs, same `clientId`, both execute a client-side tool
call (e.g. `getLocation`) and both try to continue the run. Surfaced as an
`useChat` `error` flicker; underneath, a multi-responder coordination problem.

**Direction (decided):** tolerate multiple responders, do NOT prevent/abort the
second run; reconcile downstream. See "Direction (locked 2026-06-19)" and
"Design: tolerate double-inference".

**Done + committed:**

- Part 1 (always-publish): `deriveContinuationInputs` no longer gates on
  shared tree state; emits for the last assistant's resolved tool parts. Flicker
  / infinite-loop gone. Commits: `96e4b253` (first attempt) + `0c992567`
  (refactor: continuation selection hoisted to `sendMessages`).
- Demo testing aids (TEMPORARY, remove before merge): `AGENT_LOOKUP_DELAY_MS`
  delay + `[AIT-843]` logs in the demo chat route. Commit `b35a18a2`.

**Leading design (GREENLIT by Lawrence 2026-06-22 — pursue it, starting with a
feasibility spike; not yet validated against code):**
**continuations-within-the-node** — keep the tree flat (one run node `r`); the
run's CODEC projection holds `base` + `Map<continuationId, subProjection>`; each
continuation has `cm_tc + its tool-result` and its follow-up. Machinery
codec-internal; continuation-id in the `data` payload (per AITDR-011); client mints
continuation-id; agent echoes it. Solves Problem 2. See "Leading candidate:
continuations-within-the-node".

**Two problems Part 1 surfaced:**

- **Problem 1 — merge clobber (useChat-specific):** a tab can publish a PEER's
  tool-result instead of its own (`mergeAssistant` prefers the tree's value).
  Ugly, mostly benign; useChat-only (use-client-session is immune). No fix idea
  yet; solve SEPARATELY in the Vercel/react layer.
- **Problem 2 — agent history contamination:** the leading design SOLVES this.

**Superseded — do NOT redo:** naive empty-continuation no-op (infinite-loops);
serial-bounded agent history (rejected — counterexample in notes);
distinct-run-id / sibling-NODES (fights the codec result-in-part + tree
shared-ancestor invariants); transport-tier continuation-id (violates AITDR-011).

**Spike status (2026-06-22): DONE — design is BUILDABLE.** See "Feasibility
spike (2026-06-22) — results" at the end of the file. Headline: the recursive
codec projection fits cleanly (the generic core treats the projection as fully
opaque — zero structural access outside the Vercel codec), and the agent-scope
sub-decision resolves to **(b) event-id keying**, which can act as the SINGLE
continuation key across all three bridges (fold-routing, agent-generation scope,
run-output-stream routing) and thereby ELIMINATE the client-minted
continuation-id-in-`data` machinery — directly cutting the biggest pushback risk
(overall complexity). Pre-spike action also done: last-write-wins is incidental
(commit `9bc688a4` deleted the explicit dedup gate); nothing relies on it.

**Next step (GREENLIT):** run a FEASIBILITY SPIKE on the leading design before
implementing — it's reasoned, not verified against code (`reducer.ts` /
projection shape / how `getMessages` is structured / agent continuation-id echo /
`createRunOutputStream` routing-by-continuation-id / how a continuation's
`base`-derived `cm_tc` copy is built in the projection). NOTE the projection is a
RECURSIVE tree (multi-step nesting is the normal case, not an edge case) — see
"Nesting / multi-step" in the leading-candidate section; design for the tree from
the start. Also account for replies/edits/regenerates — they add a third
`getMessages` scoping mode (scope an ancestor by the descendant's descent point);
see "Interaction with replies / edits / regenerates". The spike should
confirm buildability and surface the real shape, then resolve the open
sub-decisions: (a) codec-typed selector vs (b) event-id key for the
`getMessages` scope; the earliest-vs-latest canonical tie-break. continuation-id
grain = **per-send** (one publish = one continuation; retries/corrections don't
occur in this model — `handledRef` gives one execution per tool call per
client). Run lifecycle = shared per run `r` (resolved). Problem 1 = separate
track (Vercel/react layer). Pre-spike ACTION: find out WHY the current
last-write-wins tool-result fold exists (git blame / ask) — on our analysis it
only ever resolved the multi-tab collision (which continuations supersede), but
confirm nothing else relies on it.

---

## The immediate issue

Two browser tabs with the **same `clientId`** (same user), same session/channel.
Issue a prompt that triggers a client-side tool call (e.g. "what's the weather
like?" → `getLocation`). One tab **flickers through `useChat` status `error`**
with:

> `unable to send; inputs array is empty (include at least one input)`

Frequent, transient (recovers on its own). The conversation usually still
completes (the response arrives via sync), so it's a spurious, ugly error
rather than a hard failure.

## What this is NOT (decoupled, so we don't conflate)

- **Not** the `504` / `InputEventNotFound` ("received 0 of 1 input events"):
  that's a _general_ continuation/attach-timing lookup failure (the agent can't
  find an input event that _is_ on the channel; can happen single-tab). Being
  handled separately.
- **Not** AIT-878 / the `tool_use.input: Field required` Anthropic 400s: that's
  incomplete/interrupted runs leaving malformed history. Different family.
- Standing decision (standup): make the system **resilient to multiple clients
  executing/responding, not prevent it** (no targeting/election).

## Mechanism (root cause)

Two representations of the same tool part:

- **Overlay** = this tab's `useChat` messages. `addToolResult` flips the part to
  `output-available` _locally and immediately_.
- **Tree** = shared, channel-derived state. The part flips to resolved only when
  a `tool-result` lands on the channel and folds in — from **either** tab's
  publish.

Per-tab flow:

1. `useClientTools` scans the synced messages, sees the `dynamic-tool` part
   `input-available`, passes the clientId gate, runs `getLocation`, calls
   `addToolResult`. **Both tabs do this.**
2. `addToolResult` → overlay `output-available` → `sendAutomaticallyWhen` fires →
   `transport.sendMessages` (continuation).
3. `deriveContinuationInputs(tree, overlay)` emits a `tool-result` input **only
   when overlay is `output-available` AND the tree part is still unresolved**
   (`chat-transport.ts:337` overlay-state check; `:339`
   `if (treePart && !UNRESOLVED_TOOL_STATES.has(treePart.state)) continue;`;
   `UNRESOLVED_TOOL_STATES = {input-streaming, input-available,
approval-requested}` at `:256`).
4. If the tree part already resolved (the **other tab's** result echoed in
   first), it returns `[]` → `session.view.send([])` (`:574`) → empty-inputs
   guard throws (`client-session.ts:559`) → status flickers to `error`.

**The datum that changes in the meantime:** the _tree_ tool-part state flips
`input-available` → `output-available` (via some echo, own or the other tab's)
between the tab deciding to _execute_ and its auto-submit running
`deriveContinuationInputs`.

Race outcomes:

- **Staggered (common):** A publishes; B finds the tree already resolved → empty
  → flicker, then recovers.
- **Tight race:** both compute before any echo → both publish → two tool-results
  plus two continuations → spills into the 504/duplicate-run/stuck territory.

## Why it's really a bug

`deriveContinuationInputs` _correctly_ concludes "nothing to do" in the race, but
the transport then calls `send([])`, and `send` treats empty as a **hard error**.
A _fresh_ send with no inputs genuinely is an error; an _empty continuation_
(already resolved) should be a **silent no-op**.

## Conceptual framing

Vanilla `useChat`: client tools run via `onToolCall` on _your own stream_ —
"received it ⟹ it's mine"; state is local & authoritative. Our demo:
`useClientTools` scans **shared, channel-replicated `UIMessage` state** — an
actionable part means "_someone_ should act, maybe already has." "Unresolved"
only ever means "unresolved _as of my last sync_." The demo logic is still
written as if that state were private/authoritative — that's the bug class.

## Direction (locked 2026-06-19)

Option (A) tolerate-and-dedup is the chosen direction. Guiding principle:

> **A client that executed a client-side tool call unconditionally publishes its
> result. It must NOT suppress its own publish based on shared tree state a peer
> can mutate.** The system, not the client's read of shared state, decides what
> to do with duplicates.

"Discard" = suppress the publish to the channel. The displayed value is never
lost (it's in the overlay and arrives via sync) — what we refuse to drop is the
_publish_.

Two boundaries kept attached to the principle:

1. **It's about the result publish, not the continuation run.** Today's bug is
   that one check — "is this tool part already resolved in the tree?" (the
   `UNRESOLVED_TOOL_STATES` skip at `:339`) — governs BOTH the publish and (via
   emitting `[]` → `view.send([])` → empty-inputs throw) the run.
2. **"Don't discard" does NOT mean both results survive into history.** Both
   tabs publish AND both run (we do NOT prevent the second run — see decision
   below). Reconciliation is downstream, at READ time.

### Why `deriveContinuationInputs` checks the tree at all

`sendMessages` is handed the full overlay with no signal about _which_
resolution triggered the continuation, so it diffs overlay-vs-tree to tell NEW
resolutions from already-resolved history (which must not be re-published — the
overlay holds every prior `output-available` part too). The multi-tab dedup is
an accidental side effect of using shared, peer-mutable tree state as that
proxy. So "always emit" can't mean "delete the check" (that re-publishes all
resolved history every continuation step) — it means **replace the shared-tree
proxy with a signal authoritative to THIS client** (toolCallIds it locally
resolved but hasn't yet published — equivalently, the same "last assistant is
complete-with-tool-calls, not yet continued" condition `sendAutomaticallyWhen`
itself uses, so whenever useChat fires a continuation we always produce a real
input → never `[]` → no empty path → no flicker, no infinite loop).

## Design: tolerate double-inference, canonicalize on read (decided 2026-06-22)

### Decision: do NOT prevent the second run

Aborting/preventing the second continuation run (single-flight via a lock or an
Ably-ordering claim) is **out of scope**: the SDK has no precedent for reaching
into agent execution to cancel inference based on what a peer is doing, and the
claim approach drags in a bounded-wait timing window (same fragility class as
the 504 / InputEventNotFound lookups). So: **both tabs publish, both POST, both
agents run.** We accept the cost (2× LLM + 2× channel traffic for N racing
tabs) and reconcile at read time. Can revisit if double-inference proves a
problem in practice.

### Agent-side investigation findings (2026-06-22)

- **History reconstruction reads the live Tree projection.** `Run.messages` →
  `AgentView.messages()` → `_collectConversation` walks ancestors and calls
  `codec.getMessages(node.projection)` (`agent-view.ts`). No separate history
  cache.
- **Duplicate tool-results collapse idempotently** in BOTH readers (client tree
  and agent), because they fold ONTO the prior assistant's tool part keyed by
  `toolCallId`, last-write-wins (`fold-input.ts`). So there is NO duplicate
  tool-result _message_ — just one resolved part on the assistant.
- **No dedup of the continuation RUN anywhere.** Both invocations adopt the same
  reused runId R (`agent-session.ts:828`); in serverless they are two separate
  `AgentSession` instances, each independently publishing `run-start` / outputs /
  `run-end` under R. Duplicate `run-start`s for R are idempotent on the client
  tree (`tree.ts:1174`), so the run NODE is fine.
- **Each `Run.pipe()` mints a fresh codec-message-id** (`agent-session.ts:956`).
  So the two follow-ups are two DISTINCT messages, both folded into run node R
  (same runId → same node; distinct codec-message-id → not merged, not forked
  into siblings).

### The resulting tree shape

Scenario: user `cm_i`, assistant `cm_tc` (holds the tool call, lives in reply
run node R). Both tabs publish tool-results (Ably messages `am_tcr_1`,
`am_tcr_2`). Inference fires twice → two follow-ups `am_followup_1`,
`am_followup_2` (codec messages `cm_followup_1`, `cm_followup_2`).

- **Raw tree / projection (faithful to the append-only channel, UNCHANGED):**
  run node `R = [cm_tc(resolved), cm_followup_1, cm_followup_2]`. We cannot
  rewrite this — the messages are on the channel forever.
- **Materialized view (what we FILTER to):**
  `R → [cm_tc(resolved), <one canonical follow-up>]`. Applied identically in the
  client `View.getMessages()` (UX: avoid orphan/duplicate bubbles) and
  `AgentView.messages()` (CORRECTNESS: two consecutive assistant messages are
  malformed LLM history → Anthropic 400, the AIT-878 family).

Canonicalization is a **read-time materialization filter**, never a tree mutation.

### Run-lifecycle duplication: state-machine is safe, content flicker is the real one

Two continuation runs both adopt reused runId R and re-enter via `ai-run-resume`
(NOT `run-start` — the original run-start fired once when `cm_tc`'s run began).
So R receives two resume/end pairs. Findings (checked 2026-06-22):

- **Run STATE is flicker-safe by design.** `_applyRunResume` (`tree.ts:1268`)
  only flips `suspended → active`; a resume on an already-terminal run is a
  **no-op** ("a stray resume must never resurrect a run that has ended").
  `_applyRunEnd` (`tree.ts:1290`) only ever writes terminal→terminal (end_2
  re-marks the same terminal status; overwrites `endSerial` — harmless). So node
  state is monotonic: `suspended → active → complete`, never back to active.
- **UI re-derives from node state, not event type.** `_toRunInfo` spreads
  `...run.state` (`view.ts:251`); `useView` re-derives via
  `getMessages()`/`runs()`/`runOf()`. So even though `applyRunLifecycle` emits
  the `run` event UNCONDITIONALLY for every lifecycle event including the no-op
  resume_2 (`tree.ts:1162`), a consumer reacting to it just re-reads the
  monotonic node state → same value → no status-badge / Stop-button flicker.
- **Sharp edge for SDK consumers:** a consumer that keys off the raw
  `event.type === 'resume'` as "streaming restarted" (instead of re-reading node
  state via `runOf`) COULD flicker. The SDK's own consumers don't; worth a doc
  note for developers using `tree.on('run')` directly.
- **The REAL flicker is content, and the canonical filter fixes it.**
  `cm_followup_2`'s output chunks fold into R AFTER end_1 — so a second answer
  bubble streams in under an already-"complete" run. This is the message
  duplication; the canonical materialization filter in `View.getMessages()` drops
  it on every read, so it never reaches the rendered list. **The filter does
  double duty: correct LLM history AND no second-bubble flicker.**
- **Duplicate run-ends:** `createRunOutputStream` closes the consumer stream on
  the first matching `end`; the second `end` is an idempotent no-op (settle
  guard). Fine.

### Coherence: "follow the part", show nothing until coherent

The resolved tool-part on `cm_tc` and the kept follow-up must be a COHERENT
pair: a follow-up was generated by an agent that saw a _specific_ tool result,
so showing part = result-B with text answering result-A is incoherent (two
responders may legitimately differ — e.g. same clientId, two locations; in
general outputs can differ).

Rule: the (pinned, see below) last-write-wins fold is the single source of truth
for "which tool-result won"; the follow-up filter FOLLOWS the part (keep the
follow-up paired with the winning tool-result), it does not pick independently.
If the part-matching follow-up has not arrived yet (or its agent died), **show
nothing until the coherent one arrives** — a brief gap beats answer-≠-input.

NOTE: the existing last-write-wins reducer fold is **pinned** (not to be changed
— it presumably exists for good reason elsewhere). Canonicalization stays purely
a materialization concern.

### The provenance gap (blocks strict coherence) — KEY FINDING

To "follow the part" we must pair a follow-up with the tool-result that
triggered it. We cannot, currently, on two levels:

1. **Provenance isn't retained in the projection.** The reducer's `fold` only
   receives `ReducerMeta = {serial, messageId}` (`types.ts:158`). The triggering
   `input-codec-message-id` is read by the tree (`tree.ts:1080`) and emitted only
   transiently on the `output` event; `VercelProjection.messages` is just
   `{codecMessageId, message}` (`reducer-state.ts:59`). Materialization can't see
   it. (Solvable: thread it through.)
2. **The natural provenance field can't distinguish the follow-ups anyway.**
   Both tool-results are built `createToolResult(cm_tc, …)` — stamped with the
   prior assistant's id `cm_tc` (chat-transport.ts:343), so they fold onto it.
   Each agent resolves `resolvedInputCodecMessageId = headers[CODEC_MESSAGE_ID] =
cm_tc` (`agent-session.ts:820`). So BOTH follow-ups carry
   `input-codec-message-id = cm_tc`. That field lets us GROUP the duplicate
   follow-ups of `cm_tc` (what the filter needs to find them) but cannot PAIR
   a follow-up to a specific tool-result. The only thing distinguishing
   `am_tcr_1` from `am_tcr_2` is their Ably event-id / serial (the invocation's
   `inputEventId`), and that is NOT stamped onto the follow-up outputs.

Compounded by the pinned reducer: the projection retains only the LAST
tool-result's output on `cm_tc` (earliest is overwritten and gone). So even if we
thread provenance, we can't reconstruct the earliest result, and we can't
identify which follow-up matches whichever result won.

### Options (open decision)

- **Option 1 — best-effort coherence (proportionate).** Thread
  `input-codec-message-id` into the projection (level 1), GROUP duplicate
  follow-ups of `cm_tc`, keep earliest-by-serial. Coherent in the common case:
  when both agents load history AFTER both tool-results exist, both materialize
  the same canonical result and both answer about the same thing → either
  follow-up is coherent with the part. Possible transient part/text mismatch ONLY
  in the divergent tight race (each agent loaded before the other's tool-result
  landed). Smallest change; no wire/reducer change.
- **Option 2 — strict coherence (over-built?).** Stamp the triggering
  `inputEventId` onto follow-up outputs and thread it through so follow-ups CAN
  be paired to their tool-result; pair the kept follow-up to whichever result won
  the part; show nothing until it arrives. Wire/header + reducer-meta change, for
  a corner of a corner (the rare tight race we already accepted as the cost of
  double-inference).

Lean: Option 1. Tension: it consciously accepts that the rare tight race can
briefly show an incoherent pair — the exact thing we said to avoid. Decide
before coding the canonical filter.

### Open sub-decision: which follow-up to keep — earliest vs latest by serial

(Pinned for later; affects Option 1's tie-break.) The tie-break is
**coherence-neutral** (a follow-up's own serial doesn't track which tool-result
triggered it — the provenance gap — so neither direction reliably pairs with the
part). The filter MUST key on CGO serial regardless of direction: it is the only
reader-agnostic order (a live subscriber and a hydrating-from-history client must
converge on the same pick). The tree already maintains CGO order — the reducer
folds in canonical serial order and REFOLDS from `init` when a late wire would
land out of order (`types.ts:182-189`) — so the SETTLED state is
CGO-deterministic for everyone.

Flicker analysis (corrected — earlier draft was wrong). **Ably realtime delivery
order is NOT guaranteed to equal CGO (canonical global order).** They tend to
coincide for messages well-separated in time, but NOT for messages published
close together — which is exactly the tight-race case where the two follow-ups
arise. Consequences:

- **Well-separated follow-ups** (agents complete far apart): delivery ≈ CGO →
  earliest-by-serial wins is flicker-free (lower-serial = first-delivered, shown
  and KEPT); latest-by-serial wins yanks (replaced when the higher arrives).
- **Closely-spaced follow-ups** (the tight race): delivery order may be reversed
  vs CGO → a live subscriber can render the higher-serial follow-up first, then
  the lower arrives, the tree refolds, and the canonical pick flips → FLICKER
  under EITHER direction. The flicker is transient (bounded by the inter-arrival
  gap) and self-resolves to the CGO pick once both are present.

So neither direction is reliably flicker-free in the case that matters (the tight
race is exactly when duplication is most likely). earliest still WEAKLY dominates
(flicker-free when well-separated; indeterminate when tight — vs latest which
flickers when well-separated), but it is NOT strictly flicker-free as an earlier
draft claimed. The tool-result/part has the SAME transient flicker during
out-of-order delivery (tree refolds, last-write-wins re-settles) — so it is
symmetric with the follow-up.

Single-rule consideration (raised by Lawrence): tool-results are ALSO shown in
the UI (e.g. the user's location), so "prose is more visible" does NOT justify a
separate rule. And:

- A "single rule = latest everywhere" is consistent with the (pinned) fold;
  transient flicker happens either way in the tight race, so the consistency is
  bought cheaply.
- A truly flicker-free single rule (earliest everywhere) is IMPOSSIBLE while the
  fold is pinned: the projection retains only the LATEST tool-result (earliest is
  overwritten and gone), so we cannot display the earliest tool-result without
  un-pinning the fold. So "single rule" in practice = latest.
- The fold's last-write-wins is INCIDENTAL ("falls out of fold order" per the
  reducer comment), not a deliberate "we want yank" choice.

Trade (updated): since neither direction is reliably flicker-free in the tight
race, the earlier flicker argument for earliest is much weaker — strengthening
the single-rule case for **latest everywhere** (match the pinned fold, accept
transient self-resolving flicker). earliest only buys flicker-freedom in the
well-separated case, at the cost of diverging from the fold. UNRESOLVED;
leaning shifted toward latest/single-rule.

## Part 1 implemented + two problems it surfaced (2026-06-22)

Part 1 (always-publish) is implemented: `deriveContinuationInputs` is now a pure
`(assistant, codecMessageId) → VercelInput[]` mapping that emits a resolution for
every resolved tool part on the LAST assistant, regardless of tree state; the
"which assistant is being continued" decision lives once in `sendMessages` as a
`continuation` descriptor. This removed the empty-inputs flicker / infinite loop.

Demo testing then surfaced two deeper problems. Both are the SAME root shape as
the original bug — **a per-client / per-run action reads shared, peer-written
state and treats it as its own** — and both ultimately trace to **two actors
sharing one identity** (the same `cm_tc` for the tool result, the same reused
run-id `R` for the continuation).

Also confirmed empirically: the demo creates a fresh `AgentSession` PER POST
(`route.ts`), so it behaves serverless-like (two invocations = two independent
agents). Outcomes are non-deterministic via timing races; e.g. the
`AGENT_LOOKUP_DELAY_MS` test-aid trades the 504 (can't find the event in time)
for the prefill error below (gets far enough to load a contaminated history).

### Problem 1 — the merge clobber (content level)

Part 1 makes tab B always PUBLISH, but `mergeAssistant`
(`use-message-sync.ts:56-63`) overwrites B's overlay tool output with the TREE's
once a peer's result has folded in: `if (RESOLVED_TOOL_STATES.has(part.state))
return part` keeps the tree's value when the tree part is already resolved. So:

1. Tab B executes → its location `L_B`; `addToolResult` → overlay `cm_tc` =
   `output-available(L_B)`.
2. Tab A's result `L_A` echoes → B's tree `cm_tc` = `output-available(L_A)`.
3. `useMessageSync` fires → merge sees the tree part resolved → keeps the tree's
   value → **B's overlay `cm_tc` output is clobbered `L_B` → `L_A`**.
4. B's continuation reads its overlay → publishes `L_A`, NOT its own `L_B`.

So Part 1 did NOT achieve "publish your OWN result"; it achieved "publish
whatever the overlay holds at send time", and the overlay is peer-contaminated.
Same single-tab-assumption flaw as the original `deriveContinuationInputs` gate,
relocated into the sync merge (its docstring's "overlay wins" logic assumed
"tree resolved" ⟹ "MY echo landed", true single-tab, false multi-tab).

**useChat-SPECIFIC.** This clobber lives in `mergeAssistant`, which exists only
to reconcile useChat's SEPARATE overlay with the tree. The
`use-client-session` demo has no such overlay — its `use-client-tools.ts` builds
the tool-result from the executor's OWN output (`createToolResult(codecMessageId,
{ toolCallId, output })`) and calls `view.send` directly, so it always publishes
its own `L_B`. So Problem 1 is an artifact of the useChat dual-state
integration, NOT a core/protocol issue — its fix belongs in the Vercel/react
useChat layer. No concrete fix idea yet (the hard part: the overlay can't
distinguish "I executed this locally" from "this was synced in from the tree").

- **Staggered race (common):** B republishes A's `L_A` — redundant, weird (B did
  the work, ships someone else's answer), but the two publishes AGREE → coherent.
- **Tight race:** B publishes its own `L_B` → two genuinely different results on
  the channel → divergent content for the canonical filter.

Open question: is re-publishing a peer's result HARMFUL or just WASTEFUL? If the
results converge it's coherent and we only discarded B's redundant work — "ugly
but benign". It's harmful only when B's own result genuinely should have counted
(two devices, different real locations) — the rare tight-race divergence. So
weight Problem 1 as ugly-but-mostly-benign.

Possible amendment to the locked principle: drop "publishes its OWN result";
restate as "publishes A result; the system converges content via the tree".
UNRESOLVED.

### Problem 2 — history contamination (generation level)

Two continuations share run-id `R` and fold into the SAME run node, so
`_collectConversation` (`agent-view.ts:524-528`) appends ALL of `R`'s projection
messages. The second agent to `loadConversation()` reconstructs a history that
already ends with the FIRST agent's follow-up → `convertToModelMessages` →
conversation ends with an assistant turn → Anthropic refuses ("must end with a
user message"; assistant-prefill unsupported). The agents are NOT independent —
the loser is contaminated by the winner.

Consequences: double-inference is partly self-limiting (loser 504s or
prefill-errors → usually ONE follow-up, not two), but the loser's ERROR can
surface to the client (run-end error on `R`, via the AIT-879 stamping path) even
though the conversation succeeded via the winner. That's a real bug, not just
waste. A read-time canonical filter does NOT fix this — the contamination
happens during the second agent's GENERATION, before any read.

### Candidates for Problem 2 (none clean yet)

Root: both follow-ups fold into the SAME node `R` and are INDISTINGUISHABLE
there — same run-id `R`, same `input-codec-message-id` (`cm_tc`, the provenance
gap), and serial order is unreliable (below). So "filter out the sibling's
follow-up" has no field to key on.

- **Distinct run-id per continuation** — give each continuation its own run node
  (sibling off `cm_tc`) so `walkAncestorChain` excludes the sibling. Cleanly
  dissolves Problem 2 and hands the canonical filter clean SIBLING NODES.
  BUT the run-id reuse is **load-bearing**, not incidental: a tool-result folds
  onto `cm_tc` only because it carries `run-id = R`, which routes it into node
  `R` where `cm_tc` lives (`tree.applyMessage` → node by run-id;
  `resolveOrPend`/`findOwner` → message by codec-message-id WITHIN that node). One
  field (`sendOpts.runId = R`) currently doubles as "node the tool-result folds
  into" AND "run the response belongs to". Decoupling = a protocol change
  (two run-ids on the wire) plus resume-semantics + run-stream-routing changes.
  Disruptive. Does NOT fix Problem 1 (merge clobber is upstream of run identity).
- **Serial-bounded history — REJECTED.** Idea was: agent reconstructs history
  excluding `R` messages with serial > its trigger's serial. Fails: nothing
  guarantees the sibling follow-up's serial is > the trigger's. Counterexample
  (Lawrence): if tab 2 is slow, `am_tcr_2` publishes AFTER `am_followup_1`, so
  bounding at `serial(am_tcr_2)` does NOT exclude `am_followup_1`.
- **Detect-and-bow-out** — don't filter; read the SHAPE: if the reconstructed
  history already ends with a completed assistant answer (not the unanswered tool
  result), another agent handled it → end cleanly, don't generate (no prefill
  error). Reliable (no serials, no distinguishing the follow-ups); read-side
  single-flight via conversation shape, with the canonical filter as the
  tight-race backstop. OPEN CONCERNS: (a) likely NOT codec-agnostic — "is this
  conversation already answered / ends with a settled assistant turn" is a
  Vercel/UIMessage-level judgement, not something the generic core knows; (b) the
  exact "answered?" check is nuanced (ending with an assistant carrying an
  UNRESOLVED tool call = needs client action, not answered); (c) the mechanical
  bow-out action (clean run-end vs no-op; second run-end on `R` is idempotent).

## Parked (2026-06-22) — state of play & the core tension

**Done:** Part 1 (always-publish) — implemented + unit-tested; the empty-inputs
flicker / infinite loop is gone.

**The core tension (why this is hard):** continuations REUSE run-id `R` and
everything (both tool-results, both follow-ups) folds into the SINGLE node `R`.
That reuse is load-bearing (it's how a tool-result folds onto `cm_tc`), but it
also means concurrent actors are indistinguishable inside `R` — which is the root
of BOTH open problems and of why every cheap fix has slipped:

- **Problem 1 (merge clobber, client/content):** a tab publishes a peer's result,
  not its own (`mergeAssistant` keeps the tree's resolved value). Ugly; mostly
  benign (converges → coherent), harmful only in the rare divergent tight race.
- **Problem 2 (history contamination, agent/generation):** the second agent's
  reconstructed history ends with the first's follow-up → prefill refusal; the
  loser's error can surface to the client. A read-time filter can't fix it.

**Candidates' status:** read-time canonical filter (the original Part-2 plan) ⇒
fixes DISPLAY only; distinct-run-id ⇒ fixes Problem 2 but disruptive (load-bearing
reuse); serial-bounding ⇒ rejected; detect-and-bow-out ⇒ promising but maybe not
codec-agnostic. Problem 1 has no candidate beyond "accept it / amend the
principle".

**Honest assessment (superseded — see leading candidate below):** the mood here
was "unclear whether we're converging or wandering; the single-node-fold keeps
generating edge cases." That's partly lifted: the
continuations-within-the-node model (next section) threads the invariants and
solves Problem 2. Problem 1 remains separate and mostly benign.

## Leading candidate: continuations-within-the-node (2026-06-22)

Based on Lawrence's sketch: https://www.tldraw.com/f/r-reVRd3J5dYc7tjuLxb7?d=v-141.62.1581.1092.page

Keep the tree FLAT (one run node `r`) but make the run's CODEC PROJECTION hold
its continuations as a small internal tree — so the branching lives where tool
semantics already live (the codec), instead of fighting the generic tree or the
codec's result-in-part rule.

Shape of `r`'s projection:

- `base`: messages up to and including `cm_tc` with NO tool result (tool call
  unresolved).
- `continuations`: `Map<continuationId, subProjection>`. Each continuation holds its own
  copy of `cm_tc` with ITS tool-result folded in, plus its follow-up:
  - `c1`: `[cm_tc + am_tcr_1, cm_followup_1]`
  - `c2`: `[cm_tc + am_tcr_2, cm_followup_2]`

`getMessages(projection, selector?)`:

- no continuations → return `base` (the unresolved tool call, awaiting a result).
- a `selector` naming a continuation → recurse into that continuation.
- no selector but ≥1 continuation → pick a canonical one (the
  earliest-vs-latest tie-break, now cleaner — continuations have ids + serials)
  and recurse.

### Nesting / multi-step — the projection is a RECURSIVE tree (not flat)

This is NOT an edge case: a multi-step client-tool sequence (assistant → client
tool → result → assistant → another client tool → result → …) is ALREADY a chain
of continuations. So a continuation's follow-up (`cm_followup_1`) can itself
carry an unresolved tool call, whose resolution spawns a CHILD continuation.
Each continuation is therefore itself a `{ base, continuations }` node — the same
shape, recursively:

```
run r:
  base: [cm_tc(unresolved)]
  continuations:
    c1:
      base: [cm_tc + am_tcr_1, cm_followup_1(another unresolved tool call)]
      continuations:
        c1a: [cm_followup_1 + am_tcr_1a, cm_followup_1_1]
        c1b: [cm_followup_1 + am_tcr_1b, cm_followup_1_2]   # multi-tab at step 2
    c2:
      base: [cm_tc + am_tcr_2, cm_followup_2]   # leaf, no further tool call
```

Single-tab = a linear chain (≤1 child per continuation); multi-tab = branching at
the contested step.

**Placement keying:** the tool-result carries the codec-message-id of the message
it resolves (`createToolResult(codecMessageId, …)`). That is the "where to
attach" key: resolving `cm_tc` (home = run `r`'s base) → continuation at the `r`
level; resolving `cm_followup_1` (home = `c1`'s base) → continuation UNDER `c1`.
So **codec-message-id = where to attach; continuation-id = which sibling**; `run-id` stays
`r` throughout. No path needs encoding in the continuation-id — the codec finds the
message's home node and adds a child continuation there.

**getMessages over the tree:** display walks root→leaf applying the canonical
pick at EACH branch point (the tie-break fires once per contested step). Agent
generation: the selector identifies the LEAF continuation it's generating; the
codec reconstructs the root→leaf path (walk leaf→root), so the agent for `c1a`
sees `cm_tc+result, cm_followup_1+result` and generates from there — never `c1b`
or `c2`. Problem 2 stays solved at every depth.

**Spike implications:** the projection is a real recursive tree, so `fold` must
LOCATE the target message within a nested projection to attach the
sub-continuation (walk by codec-message-id, not a top-level map insert); the
`getMessages` selector resolves to a PATH; the canonical pick runs at every
branch level in one materialisation. Design for the tree from the start.

### Interaction with replies / edits / regenerates

The mechanism does NOT break — these all target by codec-message-id, and the
tree's `codecMessageId → nodeKey` index still maps a continuation's message
(e.g. `cm_followup_1`, which lives inside `c1` within node `r`) to node `r`. A
reply parented off `cm_followup_1` becomes a child of node `r` as usual.

But it adds a THIRD `getMessages` scoping mode (alongside canonical-display and
agent-generation): when an ancestor node is walked as part of a descendant's
history, `getMessages` for that ancestor must scope to **the continuation
containing the message the descendant parented off**, NOT the canonical pick.
Otherwise a reply that parented off `cm_followup_1` (in `c1`) while canonical is
`c2` would be reconstructed as `[cm_tc+result_2, cm_followup_2, <reply>]` —
incoherent. So `walkAncestorChain` must thread the descent point (which message
the next-deeper node parented off) into each node's `getMessages`. Applies to
edits/regenerates that target a message inside a continuation too.

UX limitation (acceptable): continuations are codec-internal, so they are NOT
exposed via the tree-level `branchSelection` / `selectSibling` API — the user
CANNOT pick which continuation branch to reply to; they reply to the canonical
one. This is fine because continuations are concurrency artifacts (multi-tab
race), not user-intended branches. User-intended branching (edit/regenerate)
stays at the tree-node level and is UNAFFECTED.

Stability risk: if the canonical pick can CHANGE after a reply (e.g. latest-wins
tie-break + a late-arriving continuation), the reply could end up under a
now-hidden branch. Reinforces the earliest / first-stable side of the
earliest-vs-latest tie-break — the canonical pick should not move once chosen.

### Relationship to the current last-write-wins fold (this model SUPERSEDES it for tool-results)

continuation-id grain = **per-send** (one publish = one continuation). This is
safe because **retry/correction does NOT occur in this model**: a client sees an
unresolved tool call, executes it ONCE (`handledRef` guards re-execution of the
same `toolCallId`), and publishes ONCE. No application loop re-publishes a
different result for the same call. So per-send never makes a single client emit
two continuations for one tool call.

Given that, the continuations model genuinely **replaces** last-write-wins FOR
TOOL-RESULTS — and loses nothing:

- Tool-results are now ROUTED by continuation-id into separate sub-projections,
  so two responders' results never COMPETE for one part. Each continuation holds
  exactly one tool-result → last-write-wins has no competition to resolve and
  never fires.
- The ONLY situation last-write-wins ever resolved for tool-results was the
  multi-tab COLLISION (two results, same `toolCallId`, same `cm_tc`) — exactly
  what separation now handles. Single-tab never produces two results for one
  `toolCallId` (unique toolCallIds; re-deliveries handled by the wire-log dedup,
  NOT last-write-wins; edits/regenerates make new messages, not re-results).

Precision: we are NOT ripping the general "last-writer-wins falls out of fold
order" property out of the reducer (it still governs text/reasoning/etc.). We
change tool-result ROUTING so cross-responder results land in different
continuations; the property simply stops being exercised for them.

ACTION before relying on this: **find out WHY last-write-wins exists** (git blame
/ ask the author). The reducer comment frames it as incidental ("falls out of
fold order"); on our analysis it only ever resolved the multi-tab collision, but
confirm nothing else deliberately relies on it for tool-results.

PUSHBACK risk (separate from last-write-wins): the bigger review concern is the
OVERALL complexity — recursive codec projection + continuation-id-in-`data` +
three `getMessages` scoping modes — to handle a multi-tab-same-clientId case. Be
ready for a complexity-vs-benefit conversation.

### Why it threads the invariants (where sibling-NODES failed)

- **Tree stays flat** → the generic tree's shared-ancestor model is untouched
  (no branch-variant `cm_tc`).
- **Codec owns the branching** → within each continuation `cm_tc` is folded WITH
  its result, so result-in-part holds. The codec is the layer allowed to know
  "result goes in the part".
- **Continuations have explicit ids** → resolves the indistinguishability that
  broke the single-node model.

### Layering (per AITDR-011)

- **Machinery = codec-internal**: projection hierarchy, fold routing into a
  continuation, recursive `getMessages`. The generic tree stores `r`'s projection
  opaquely and never sees continuations.
- **continuation-id lives in the event `data` payload** (codec-specific, NOT `extras.ai`)
  — AITDR-011: codec-specific fields go in `data`, passed through verbatim. So
  fold routing needs NO generic change: the codec decodes continuation-id from `data`
  into the event, `fold` reads `event.continuationId` and routes. (Earlier idea of a
  transport-tier continuation-id token: WRONG, retracted — violates AITDR-011.)
- **Client mints its own continuation-id** (fresh per send) → two tabs get distinct ids
  with zero coordination, while still publishing with `run-id = r` (so the fold
  lands on `cm_tc` and resume semantics survive). The "which run do I target"
  dilemma disappears — you always target `r`; continuation-id is the per-responder split.
- **Agent echoes the continuation-id** onto its follow-up outputs (like it echoes
  `input-codec-message-id`) so the follow-up folds into the right continuation.

### The one bridge: the agent's `getMessages` scope

`AgentView` is generic and can't read `data`, but it must scope `getMessages` to
the continuation it is generating. Two AITDR-011-respecting options (continuation-id
stays in `data` either way):

- **(a) codec-typed selector forwarded opaquely**: `getMessages(projection,
selector?: TSelector)`; generic core treats `TSelector` as opaque, Vercel types
  it. The agent forwards a value it already holds as an opaque codec type — its
  triggering input `TInput` — and the codec reads continuation-id from that input's
  `data`. Cost: `Run` retains its decoded triggering `TInput`.
- **(b) key the continuation by the triggering `event-id`**: event-id is ALREADY
  generic/transport-tier and the agent already has it
  (`invocation.inputEventId`). The codec keys each continuation by its seeding
  tool-result's event-id; the agent scopes with the event-id it holds; the codec
  maps event-id → continuation internally (needs event-id in `ReducerMeta` —
  generic, fine — and the agent echoes the triggering event-id on outputs). Less
  agent-side plumbing; reuses an existing generic handle.

### What it solves / doesn't

- **Problem 2 (history contamination): SOLVED.** The agent reconstructs history
  scoped to its OWN continuation → ends at the tool result → never sees a
  sibling's follow-up → no prefill error, no detect-and-bow-out needed.
- **Problem 1 (merge clobber): NOT solved — separate / upstream.** It's a
  client-overlay-merge issue: at `sendMessages`, `mergeAssistant` has already
  overwritten the overlay's local result with the tree's, so the tab publishes a
  PEER's result (into its own continuation-id). The node structure doesn't touch the
  overlay. Silver lining: when the clobber does NOT happen (tight race, B keeps
  `L_B`), this design gives the two divergent results a clean home (two
  continuations). Problem 1 stays "ugly but mostly benign"; its fix (or
  accept + amend the principle to "publishes A result, not necessarily its own")
  is independent of this design.

### Clobber vs divergence under this design (reframes Problem 1's value)

What the two continuations look like, by case:

- **Clobber case** (staggered; B's overlay overwritten to `L_A` before it
  publishes): `c1 = (L_A, followup_A)`, `c2 = (L_A, followup_A')` — two distinct
  continuations, two INDEPENDENT follow-up generations (different
  codec-message-ids, possibly different wording), but both based on `L_A`. So the
  pair is REDUNDANT: canonical pick is harmless, but it cost a wasted second
  inference AND silently dropped B's real `L_B`.
- **Non-clobber / tight race** (B keeps `L_B`): `c1 = (L_A, followup_A)`,
  `c2 = (L_B, followup_B)` — genuinely divergent, and under this design that's the
  RICHER, cleaner outcome: both data points preserved as continuations, display
  picks one, the other still exists.

So the design INVERTS the earlier framing: the "divergent" case (previously
flagged harmful) is actually the better one here; the CLOBBER is the lossy,
wasteful one. That raises the payoff of fixing Problem 1 — a fix turns a
redundant+lossy pair into a meaningful pair, not merely "avoids republishing a
peer's result". (Reality caveat: today one agent often 504s, so you frequently
see only one follow-up; the two-redundant-continuations picture is the
both-succeed case, reachable with the AGENT_LOOKUP_DELAY_MS aid.)

### Open questions before committing

- **Lifecycle scoping** — RESOLVED: run `r` keeps ONE shared lifecycle.
  Per-continuation lifecycle gains nothing: the run lifecycle
  (run-start/suspend/resume/end, `RunInfo.status`) is a GENERIC concept keyed by
  run-id and surfaced to users via `runOf`/`runs()`, whereas continuations are
  codec-internal (no generic API to expose per-continuation status), and the
  agent is ephemeral (knows its own outcome directly). The residual wrinkle is
  NOT lifecycle: `createRunOutputStream` routes by `inputCodecMessageId`
  (= `cm_tc`, SHARED across continuations), so to stream the right continuation's
  follow-up to useChat it must route by continuation-id instead.
- **(a) vs (b)** for the agent's scope handle.
- The canonical-pick tie-break is the still-open earliest-vs-latest sub-decision,
  now applied to continuations.

## Fallback: observer stream (option B) — only if (A) proves intractable

Keep the current race-dedup (loser does NOT publish), but on the empty-inputs
path, instead of returning an empty stream (which infinite-loops — see
`lawrence-learnings/why-the-sender-loses-the-race.md`), hand useChat a stream
that **observes the winner's in-flight continuation run**. That delivers a real
terminal chunk → clears `sendAutomaticallyWhen` → no loop, correct status.

This contradicts the locked principle (it discards the loser's result) and only
fixes the STAGGERED race — the tight race still double-publishes/double-runs. So
it's a partial, pragmatic fix, recorded as a fallback if A's downstream
single-flight/dedup proves intractable in serverless.

Feasibility (checked 2026-06-19):

- Output events already carry `runId` (`OutputEvent.runId`, stamped at
  `tree.ts:1120`). The loser knows the reused continuation runId R via
  `view.runOf(assistantCodecMessageId)`.
- `createRunOutputStream` is ~90% reusable: generalise its routing predicate from
  `inputCodecMessageId` match to `runId === R`. Run-lifecycle close-on-end and
  terminal-chunk detection are reusable as-is.
- Main risk: the join-mid-stream / catch-up gap. `tree.on('output')` is live
  (post-subscribe only); the loser subscribes AFTER the winner started, so it can
  miss chunks or join after the `start-step` and choke useChat. A proper fix
  needs seeding from `tree.getRunNode(R)` then subscribing for the rest —
  non-trivial (projection → chunk-stream reconstruction). Same timing-fragility
  class as the 504 / InputEventNotFound lookups.

NOTE (corrected 2026-06-22): the `byRun(R)` observer-stream primitive is NOT
needed by the chosen direction. Under tolerate-double-inference, EVERY tab
publishes and runs its own continuation, so every tab consumes its own run
stream (keyed on its own tool-result's `inputCodecMessageId`) — nobody is left
streamless. The observer primitive is only needed if a run is SUPPRESSED
(single-flight / option B), which we are not doing. (Earlier note claiming A
needs it was wrong.)

## Key code locations

- `src/vercel/transport/chat-transport.ts` — `deriveContinuationInputs` `:290`
  (`:256` UNRESOLVED set, `:337` overlay-state check, `:339` skip-if-resolved);
  continuation send call `:573-574`; `hasUnresolvedToolCall` `:243` (used `:475`).
- `src/core/transport/client-session.ts:559` — empty-inputs guard (throws).
- `demo/vercel/react/use-chat/src/app/hooks/use-client-tools.ts` — execute +
  `addToolResult`.
- `chat.tsx` — `sendAutomaticallyWhen`; `useMessageSync` syncs tree → overlay.

## Related tickets

AIT-843 (this), AIT-878 (incomplete runs), AIT-879 (run-end error stamping —
now merged to main, `26d5a46c`).

## Feasibility spike (2026-06-22) — results

Verified the continuations-within-the-node design against the actual code. Read
`reducer.ts`, `reducer-state.ts`, `fold-input.ts`, core codec `types.ts`,
`tree.ts`, `agent-view.ts`, `view.ts`, `agent-session.ts`, `run-output-stream.ts`,
`chat-transport.ts`, `invocation.ts`, `client.ts` (ActiveRun). **Verdict: the
design is buildable.** No invariant blocks it. Details below; line refs are
against the worktree at spike time.

### Pre-spike ACTION (done): why last-write-wins exists — it's INCIDENTAL

`git blame` on the reducer's last-write-wins comment lands on commit `9bc688a4`
("Vercel codec: delete the conflict-key dedup gate", Mike Christensen). It
DELETED an explicit per-conflict-key high-water-mark (`conflict-key.ts` +
`conflictSerials`) that previously made folds idempotent / last-writer-wins under
out-of-order delivery. It was removed because **the transport now owns ordering**
(the Tree sequences each node's wires canonically and drops whole-wire replays via
a per-message version high-water-mark), so the reducer folds unconditionally and
"last-writer-wins falls out of fold order." So for tool-results, last-write-wins
is the incidental residue of removing redundant machinery — NOT a deliberately-
relied-on semantic. This confirms the design's claim: routing tool-results into
separate continuations "replaces" last-write-wins for them and loses nothing
(the property still governs text/reasoning/etc. and simply stops being exercised
for tool-results). The fold stays pinned for everything else; no un-pinning needed.

### Finding 1 — the projection is fully OPAQUE to the generic core (STRONG positive)

Grepped the entire `src/core/` for any structural access to projection internals
(`.messages` / `.trackers` / `.continuations`): **zero hits**. The core only ever
calls `codec.init()`, `codec.fold(projection, event, meta)` (`tree.ts:488,605`),
and `codec.getMessages(node.projection)` (16 call sites: 13 in `view.ts`, 3 in
`agent-view.ts`). The tree stores `node.projection` as an opaque blob. So the
recursive `{ base, continuations: Map<key, node> }` shape lives ENTIRELY inside
the Vercel reducer — no generic-tree change for the branching itself. This is
exactly what the design's AITDR-011 layering claim needs, and it's true in code.

### Finding 2 — route-then-fold makes the recursive rewrite tractable

All 7 `fold-*` helpers operate on `state` via `ensureMessage` / `ensureTrackers` /
`state.messages` / `findOwner` (30 references). If the reducer's dispatcher first
SELECTS the target sub-projection node (by continuation key) and passes THAT node
as `state` to the existing per-concern fold helpers, the helpers run essentially
unchanged. The rewrite is therefore: (a) make `VercelProjection` recursive —
`{ messages, trackers, pendingToolResolutions, continuations: Map<key, node> }`
where each continuation is the same node shape; (b) add a routing layer in `fold`
that picks base-vs-continuation by the event's continuation key; (c) rewrite
`getMessages` to walk root→leaf with the canonical pick at each branch (+ optional
selector). Trackers become per-node (each sub-projection owns its maps) — fine,
since `cm_tc` appears in base AND in each continuation (a deep COPY with that
continuation's result folded on), and follow-ups live in their continuation.
Meaty but well-contained to the Vercel codec.

### Finding 3 — the continuation key: resolve (a) vs (b) → choose (b) event-id, and it UNIFIES all three bridges

The three places that need to know "which continuation":

1. **Fold routing** (reducer): which sub-projection a tool-result / follow-up
   folds into. Reducer only gets `ReducerMeta = {serial, messageId?}` (`types.ts:158`).
2. **Agent-generation scope** (`AgentView._collectConversation` → `getMessages`,
   `agent-view.ts:505-530`): the agent must reconstruct history scoped to ITS
   continuation (root→leaf), never a sibling's.
3. **Run-output-stream routing** (`run-output-stream.ts:141`): currently routes by
   `event.inputCodecMessageId` (= `cm_tc`, SHARED across continuations) → today
   both tabs' streams would receive BOTH follow-ups. Must route per-continuation.

The decisive code fact: **the triggering event-id is a transport-tier identifier
that BOTH sides already hold.** `ActiveRun.inputEventId` (`client.ts:133`) gives
the client its own tool-result publish's event-id synchronously at send time; the
agent has the same value as `invocation.inputEventId` (`invocation.ts`). `event-id`
is a generic header (`HEADER_EVENT_ID = 'event-id'`, `constants.ts:48`), already
indexed in the tree (`_eventIdIndex`, `tree.ts:341`), already stamped on inputs
(`headers.ts:89`) and forwarded in the POST body. So option (b) keys each
continuation by its seeding tool-result's event-id and serves ALL THREE bridges
with one key, via minimal generic plumbing:

- The agent echoes the triggering input's event-id on its continuation outputs as
  a generic provenance header (only when `resolvedContinuation` — `agent-session.ts:829`).
  Name it transport-generically (e.g. `triggering-event-id` / `input-event-id`),
  NOT "continuation" — it states a pure transport fact ("which input caused this
  output"); the CODEC interprets it as the continuation key. This also closes the
  "provenance gap" the Problem-2 analysis lamented.
- The tree threads that header into `ReducerMeta` (a new generic `triggeringEventId?`
  field) → reducer routes outputs into the keyed continuation. For tool-result
  INPUTS, the codec uses the input's OWN event-id (the wire's `event-id`) — and it
  already discriminates seeds by `kind: 'tool-result'`, so base-vs-continuation
  needs no extra signal. The original run's `cm_tc` stream / user message carry no
  echoed triggering-event-id (not a continuation) → fold into `base`.
- The tree also adds `triggeringEventId` to its `output` event (`tree.ts:1120`)
  so `run-output-stream` can match `event.triggeringEventId === run.inputEventId`.
- The agent scopes `getMessages` with the event-id it already holds
  (`invocation.inputEventId`) — no decoded-`TInput` retention needed (that was
  option (a)'s cost).

**Why this beats the design-as-sketched:** the sketch had the client MINT a
continuation-id, carry it in the event `data` payload, the agent DECODE it from
`data` and echo it. Option (b) needs none of that — no client-minted id, no
continuation-id-in-`data`, no codec `data` decode for routing. It reuses an
existing transport-tier handle and is arguably MORE AITDR-011-compliant (the
routing key is transport provenance in an `x-ably-*`-class header, not codec
domain data). This directly attacks the design's biggest stated pushback risk
(overall complexity: "recursive projection + continuation-id-in-`data` + three
scoping modes"). Recommend (b); drop the client-minted-continuation-id-in-`data`
mechanism unless a later need for a domain-level id surfaces.

Caveat to weigh: (b) keys a codec-internal structure (continuations) on a
transport identifier (event-id). It stays opaque to the codec (just a Map string
key) and the codec never parses it, so this reads as acceptable, not a layering
violation — but it's the one judgement call to confirm with review.

### Finding 4 — getMessages selector blast radius is small

Adding `getMessages(projection, selector?)` with `selector` defaulting to the
canonical pick keeps all 13 `view.ts` canonical-display call sites working
UNCHANGED. Only the agent-generation path (`agent-view.ts`, 3 sites) and the
reply/edit "descent-point" scoping (the THIRD mode — scope an ancestor to the
continuation the descendant parented off, threaded through `walkAncestorChain`,
`agent-view.ts:85`) must pass a selector. So the required-change surface is the
agent-view walk + descent-point threading; display gets the canonical default free.

### Finding 5 — recursive nesting / multi-step confirmed as the normal case

The fold must LOCATE the target message within a nested projection (walk by
codec-message-id to find the home node, then attach a child continuation there),
because a follow-up can itself carry an unresolved tool call whose result spawns a
child continuation. `findOwner` (`fold-input.ts:209`) currently does a flat
`state.messages.find` — under the recursive model it becomes a recursive search
for the home node, then attach/seed the child continuation. Selector resolves to a
PATH; the canonical pick fires once per branch level in one materialisation. No
blocker — just must be designed for the tree from the start (as the notes say).

### Still-open sub-decisions after the spike

- **Earliest-vs-latest canonical tie-break.** Unchanged by the spike (it's a
  display/coherence choice, not a buildability one); now applied per-continuation
  with explicit keys. Prior analysis leans **latest / single-rule** (matches the
  pinned fold; neither direction is reliably flicker-free in the tight race). The
  reply-stability risk argues weakly for first-stable. Lower-stakes; decide when
  coding the canonical filter.
- **Coherence Option 1 vs 2** (best-effort vs strict follow-the-part). Under (b),
  continuations are already separated by event-id so each holds exactly one
  result+follow-up pair — the pairing the provenance gap blocked is now intrinsic.
  This effectively delivers Option-2-grade coherence WITHOUT the extra wire/reducer
  stamping Option 2 required (event-id keying does the pairing). Revisit framing
  when implementing; likely moots the Option 1/2 split.
- **Confirm the layering judgement** in Finding 3's caveat with review.

### Suggested implementation order (groundwork-first, reviewable)

1. Generic: add `triggeringEventId?` to `ReducerMeta` + tree `output` event; tree
   reads the new provenance header at fold/emit time (no behaviour change yet —
   reducer ignores it).
2. Agent: echo the triggering input's event-id as the provenance header on
   continuation outputs (`Run.pipe`); pass the event-id selector to `getMessages`.
3. Generic: add the optional `selector` param to `Codec.getMessages` + thread the
   descent point through `walkAncestorChain` (default = canonical; no behaviour
   change for existing flat codec).
4. Vercel codec: make `VercelProjection` recursive; route-then-fold; recursive
   `getMessages` with canonical pick + selector. This is the bulk.
5. Vercel: route `run-output-stream` by `triggeringEventId === run.inputEventId`.
6. Remove now-dead continuation-id-in-`data` ideas if any were scaffolded (none yet).

Each step is independently typecheck-able; steps 1–3 are mechanical groundwork.
