# AIT-843 — multi-tab client-side tool-call "empty inputs" flicker

_Working notes (scratch). Investigation captured before context loss._
_Line numbers re-anchored against `26d5a46c` (origin/main, incl. AIT-879)._

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
