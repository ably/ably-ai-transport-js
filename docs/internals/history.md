# History hydration

The transport reconstructs past conversation state by paging an Ably channel's history backward and folding each wire into the [Tree](conversation-tree.md). One engine — the **history hydrator** (`createHistoryHydrator`, `src/core/transport/history-hydrator.ts`) — serves every history route: the client [View](client-session.md)'s `loadOlder()` pagination, and the agent's [input-event lookup](agent-session.md#input-event-lookup) and ancestor hydration. A single engine means the two sides cannot drift on stop conditions or exhaustion, and a session pages its channel **once** across concurrent callers.

## Two layers

- **`loadHistoryPages` (`src/core/transport/load-history-pages.ts`)** — the low-level cursor. It [attaches the channel](glossary.md#channel-attach-ably) (idempotent), then pages `channel.history()` with [`untilAttach: true`](glossary.md#untilattach-ably), exposing a `HistoryPagesCursor` with `hasNext()` (cheap, no network) and `next()` (one Ably page per call, newest-first within the page, with bounded retry/backoff). It returns **raw** Ably messages and does not decode.
- **`HistoryHydrator` (`src/core/transport/history-hydrator.ts`)** — drives that cursor and folds each page into the Tree as it pages. It owns one cursor per attach epoch and exposes `foldUntil(shouldStop, signal?)` and `hasNext()`.

## The problem

Ably's history API returns messages newest-first, but [stream accumulation](decoder.md#stream-tracker) needs them oldest-first (the create before its appends), and a single domain message may span many [wire messages](wire-protocol.md#streamed-messages) (create + N appends + close) and page boundaries. The hydrator reverses each fetched page to chronological order before folding, so projections build oldest-to-newest exactly as they do live.

## Fold while paging — the caller owns the stop

Unlike a fetch-then-decode design, the hydrator folds each page straight into the Tree through the Tree's shared decode-and-apply engine (`foldAndEmit` → `applyWireMessage`, `src/core/transport/decode-fold.ts`) — the **same** engine and decoder instance the live subscription uses, so history replay and the live loop can never drift. There is no separate completion counter and no "how far back" heuristic: each caller expresses its own stop condition as a predicate.

`foldUntil(shouldStop, signal?)`:

1. Lazily opens the cursor on first use (capturing the attach serial then).
2. Before each page, polls `shouldStop()`; if true, pauses — the cursor stays open for the next caller.
3. Otherwise fetches the next page, reverses it to chronological order, and folds each wire into the Tree.
4. Stops when the predicate trips, the channel is exhausted, or `signal` aborts.

It returns `{ exhausted }`, true only when the cursor genuinely reached attach. The hydrator records exhaustion once, and `hasNext()` reports it truthfully thereafter — it returns `true` before the cursor is first opened, because exhaustion is unknown until something pages.

Because folding is idempotent — the shared decoder's version-guarded [stream trackers](decoder.md#stream-tracker) drop re-delivered content and the Tree's per-entry high-water-mark drops whole-wire replays — a wire that surfaces both live and via a history page folds exactly once. This is what makes the overlap between the `untilAttach` history scan and the live subscription safe.

## Single-flight shared cursor

The cursor is **single-flight**: concurrent `foldUntil` calls serialise behind one another, so the cursor is advanced by one caller at a time and a follower resumes from where the previous caller paused rather than re-paging from newest. An agent's pre-run-start input-event lookup and a concurrent ancestor hydration therefore share each other's folded pages — the channel is walked once. A failed page fetch is isolated to its own caller (it rejects that `foldUntil`); a follower still runs its own walk.

The hydrator follows the lifecycle of the Tree it folds into: the client session creates one; the agent session recreates it alongside the Tree and applier on a channel continuity-loss swap, so the fresh Tree gets a fresh cursor and exhaustion state.

## Stop predicates, per caller

| Caller                                                                               | `shouldStop` predicate                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Client `View.loadOlder`                                                              | enough newly-visible codecMessages have folded to cover the requested page                                         |
| Agent input-event lookup ([`locateInputEvent`](agent-session.md#input-event-lookup)) | the triggering `event-id` has been found (via the Tree's `ably-message` event the fold emits)                      |
| Agent ancestor hydration (`run.view` drain)                                          | each reveal covers its page; the agent repeats `loadOlder` until `hasOlder()` is false (channel history exhausted) |

The transport never reads inside a domain message to decide when to stop — the criterion lives entirely in caller code.

## Client pagination

`View.loadOlder(limit)` (default `10`) reveals up to `limit` older codecMessages. After draining what it already holds (hidden messages and the withheld-node buffer), it drives `foldUntil` with a predicate that stops once enough newly-visible codecMessages have folded to cover the remaining page budget — all under a processing-history guard (so a fold doesn't surface transient events before the window is set up) — then reveals the newest whole runs covering the page, withholds the rest for the next call, and resolves to the revealed page (the newly-prepended codecMessages, oldest-first). `View.hasOlder()` reads `hydrator.hasNext()` for its history component, so it reflects real cursor exhaustion: it is optimistically `true` before the first fetch (history may exist) and `false` once the channel is drained — which is what the `while (view.hasOlder()) await view.loadOlder()` drain loop relies on.

```typescript
await view.loadOlder(10);
// view.getMessages() — the concatenated flat TMessage list across visible Runs
// view.runs()        — the visible RunInfo[]
// view.hasOlder()    — whether more history may be revealed
```

A run whose stream is still in progress, or spans a page boundary, simply contributes to a projection that completes once a later page supplies the rest of its wires — no special handling at the fold, because folding is incremental and idempotent. Concurrent runs stay isolated for the same reason they do live: each wire folds into its owning node's projection, keyed by [`run-id`](wire-protocol.md#transport-headers). The agent's [`run.view`](agent-session.md#run-view) is the one place that does treat an in-progress run specially: paging still stops only on history exhaustion, but the materialised branch its `getMessages()` returns omits ancestor runs that have not completed (and the inputs they replied to), so a broken earlier turn can't leak an unresolved tool call into the prompt fed to the model.

## Page size

The cursor fetches a configurable number of wire messages per Ably page - the `historyPageSize` option on `createClientSession` / `createAgentSession` (`DEFAULT_HISTORY_PAGE_SIZE`, 100) - over-provisioning for the many-wire-messages-per-domain-message ratio so a single round-trip usually covers several domain messages. `loadOlder`'s `limit` controls how many codecMessages are **revealed**, decoupled from how many wires are fetched per round-trip.

## Channel attach and untilAttach

The cursor [attaches the channel](glossary.md#channel-attach-ably) (idempotent) and uses [`untilAttach: true`](glossary.md#untilattach-ably), so there is no gap between historical messages and the live subscription — history ends exactly where the subscription starts.

See [Decoder](decoder.md) for how wires become domain events, [Conversation tree](conversation-tree.md) for how folded events group by owning node, and [Agent session](agent-session.md#input-event-lookup) for the input-event lookup that shares this engine.
