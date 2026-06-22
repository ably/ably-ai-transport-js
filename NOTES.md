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

1. **It's about the result publish, not the continuation run.** We deliberately
   want exactly one agent run (single-flight). Today's bug is that one
   check — "is this tool part already resolved in the tree?" (the
   `UNRESOLVED_TOOL_STATES` skip at `:339`) — governs BOTH the publish and (via
   emitting `[]` → `view.send([])` → empty-inputs throw) the run. Separate them:
   publish unconditionally, single-flight the run downstream.
2. **"Don't discard" does NOT mean both results survive into history.** Both
   tabs publish; reconciliation is downstream: the client tree fold is
   idempotent (`fold-input.ts` `resolveOrPend`/`applyResolution`, keyed by
   `toolCallId`, last-write-wins) + agent-side single-flight on the continuation
   runId (continuations reuse the suspended run's runId, identical across tabs —
   `chat-transport.ts` `sendOpts.runId = run.runId`). Suppression moves from a
   non-deterministic source-side race to deterministic downstream dedup.

### Why `deriveContinuationInputs` checks the tree at all

`sendMessages` is handed the full overlay with no signal about _which_
resolution triggered the continuation, so it diffs overlay-vs-tree to tell NEW
resolutions from already-resolved history (which must not be re-published — the
overlay holds every prior `output-available` part too). The multi-tab dedup is
an accidental side effect of using shared, peer-mutable tree state as that
proxy. So "always emit" can't mean "delete the check" (that re-publishes all
resolved history every continuation step) — it means **replace the shared-tree
proxy with a signal authoritative to THIS client** (toolCallIds it locally
resolved but hasn't yet published).

### Open verification before scoping the agent-side work

Trace the agent's `loadConversation` / `AgentView` path to confirm duplicate
tool-results collapse idempotently there too. Client tree confirmed; agent
history reconstruction not yet. If it doesn't dedup, the agent-side work is
single-flight + history-level dedup; if it does, it's just single-flight on the
reused continuation runId.

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

NOTE: the `byRun(R)` observer-stream primitive is probably needed by option A
too — a tab whose run is deduped downstream still needs its useChat stream to
show the canonical run. So the primitive is NOT throwaway even under A; only the
"keep race-dedup on the empty path" wiring is B-specific.

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
