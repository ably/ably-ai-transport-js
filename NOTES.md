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
  + two continuations → spills into the 504/duplicate-run/stuck territory.

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

## Fix (open design question)

- **Necessary, immediate:** at `chat-transport.ts:573`, when
  `deriveContinuationInputs` returns `[]`, short-circuit to a **no-op** (return
  an empty/closed stream to `useChat`) instead of calling `send`. Keep the
  `client-session:559` empty guard for _fresh_ sends. This removes the flicker.
- **But it only fixes the symptom.** The behaviour stays racy. The real decision:
  - **(A) tolerate-and-dedup** — all tabs publish; dedup results downstream;
    _single-flight the continuation_. Principled, but gated on a single-flight
    mechanism (the core unsolved AIT-843 gap).
  - **(B) best-effort one-responder** — keep the `:339` race-dedup, make empty a
    clean no-op, accept non-deterministic which tab publishes; treat residual
    double-publish as the separate single-flight work.
- The fix _line_ is the same either way; the question is which model it serves.

## Code-quality finding (separate from the fix)

`hasUnresolvedToolCall` (`chat-transport.ts:243`, used at `:475`) inlines the
**same three states** as `UNRESOLVED_TOOL_STATES` (`:256`) — duplicated literal,
drift hazard. They're the same concept ("tool call still awaiting a
result/approval"), just applied to the overlay vs the tree. DRY cleanup: hoist
the set, have `hasUnresolvedToolCall` use it, and sharpen the doc. No behaviour
change (the literals already match).

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
