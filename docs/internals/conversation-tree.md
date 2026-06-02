# Conversation tree

The conversation tree (`src/core/transport/tree.ts`) materializes a branching conversation as a forest of **Runs**, keyed by `run-id`. It handles Run ordering and sibling grouping for edit/regenerate forks. The tree is a data structure with codec wiring - it owns the per-Run [TProjection](glossary.md#tprojection) and folds inbound events into it, but selection state and navigation (`select()`, `getSelectedIndex()`) live on the View.

The tree is the single source of truth for conversation state. The view's `flattenNodes()` delegates to the tree's internal `flattenNodes()` with pagination filtering and branch selection.

Each Run can contain multiple messages (user prompt, assistant text, tool calls, tool outputs, continuation text) which the codec folds into a single per-Run projection. The View walks the parent chain across Runs and concatenates each Run's `codec.getMessages(projection)` to produce the flat message list the UI renders.

## Ordering: serial-first

Ably assigns a [serial](glossary.md#serial-ably) - a lexicographically sortable string identifier - to every message on acceptance. The tree sorts Runs by **startSerial** (the serial of the first observed message tagged with that run-id):

- **Serial-bearing Runs** sort lexicographically by startSerial
- **Null-startSerial Runs** (optimistic inserts before [server relay](wire-protocol.md#optimistic-reconciliation)) sort after all serial-bearing Runs, ordered among themselves by insertion sequence

Note that serial order is not necessarily delivery order - Runs published concurrently from different connections may interleave in any order. Serial order provides a stable, deterministic total order, reflecting Ably's acceptance order rather than any single client's observation order. Parent headers ([`parent`](wire-protocol.md#branching-headers)) are only structurally meaningful at branch points - for linear sequences, startSerial order is sufficient.

## Data structures

```
_runIndex:           Map<runId, InternalRunNode>     Primary index
_msgIdToRunId:       Map<msgId, runId>               Secondary: msg-id -> owning runId
_sortedRuns:         InternalRunNode[]               All Runs, sorted by startSerial
_parentIndex:        Map<parentRunId, Set<runId>>    Children of each parent Run
_runClientIds:       Map<runId, clientId>            Active runs for cancel filtering
_structuralVersion:  number                          Monotonic counter (see below)
```

Each `RunNode<TProjection>` stores:

```typescript
{
  runId: string; // From run-id
  parentRunId: string | undefined; // Resolved via _msgIdToRunId from parent
  forkOf: string | undefined; // runId of the forked Run (resolved from fork-of)
  clientId: string; // From run-client-id - the client that started this Run
  status: 'active' | 'complete' | 'cancelled' | 'error' | 'suspended';
  projection: TProjection; // Codec-folded per-Run state
  startSerial: string | undefined; // First observed message's serial
  endSerial: string | undefined; // run-end lifecycle event's serial
}
```

## Apply: the two mutation entry points

The tree exposes two mutation methods on its internal interface (used by the session, not the UI):

### `applyMessage({ inputs, outputs }, headers, serial?)`

The entry point for every inbound channel message. The decoded events arrive split by wire direction — `inputs` (client-published, `ai-input`) and `outputs` (agent-published, `ai-output`). Routes by `run-id`, creates the Run if needed, folds both sets into the Run's projection (inputs first), and maintains the `msgId -> runId` index. After the fold it emits an `'output'` event carrying the message's `outputs` plus routing metadata (`runId`, `codecMessageId`, `serial`), then `'update'` when the structure changed.

Three message kinds flow through here:

1. **Fresh user prompt**: creates the Run if missing, folds events into the projection.
2. **Continuation tool-resolution** (`run-continue: 'true'`): routes to the existing Run via `_msgIdToRunId`, folds events.
3. **Assistant/agent events**: routes to the existing Run by runId, folds events.

The optimistic send path (client publishing a fresh user-message) calls `applyMessage` with a `undefined` serial. When the server relay arrives, the same Run's startSerial gets promoted from null to a real serial, and the Run re-sorts.

### `applyRunLifecycle(event)`

Handles `ai-run-start` and `ai-run-end` wire events. The event carries its own channel `serial`. Run-start sets `status` to `'active'`, promotes `startSerial` from the event's serial, and tracks the run as active. Run-end sets `status` to the end reason, sets `endSerial` from the event's serial, and untracks the run. Always emits a `'run'` event to subscribers.

### Structural version

The tree maintains a `structuralVersion` counter (exposed via `TreeInternal`) that increments on changes affecting `flattenNodes()`'s output structure - Run insertions, deletions, and startSerial promotions (which reorder `_sortedRuns`). **Projection-only updates do not bump the counter**: streaming deltas update an existing Run's projection in place, observable via the `'output'` event instead. The tree uses this distinction to emit `'update'` only on structural change, so streaming deltas never trigger a View tree walk.

## Sibling groups and fork chains

When a user calls `regenerate(msgId)` or `edit(msgId)`, a **new Run** is started whose `forkOf` points at the (runId, msgId) being replaced. Runs that fork the same target (or transitively fork each other) form a **sibling group** - alternative Runs at the same point in the conversation.

### Finding the group

To find the sibling group for a Run:

1. Follow the `forkOf` chain to the **[group root](glossary.md#group-root)** - the original Run that has no `forkOf` (or whose `forkOf` target has a different parentRunId)
2. Collect all Runs with the same `parentRunId` whose `forkOf` chain leads back to the group root
3. Sort siblings by startSerial (newest last)

Cycle detection guards against malformed `forkOf` chains.

### Selection

Each sibling group has a selected Run (default: the latest, i.e. the most recent fork). Selection state is managed by the View - `view.select(runId, index)` changes which sibling is active. The selection is stored by the group root's runId.

## Flatten: producing the visible Run chain

`flattenNodes()` walks `_sortedRuns` and produces the linear Run chain for the currently selected branches:

```
for each Run in startSerial order:
  1. Check parent reachability - is parentRunId in the current path?
     (Root Runs with undefined parentRunId are always reachable)
  2. Check sibling selection - if this Run is in a sibling group,
     is it the selected sibling?
  3. If both pass: add to the path
```

Runs that fail either check are skipped - they're on unselected branches. The View then concatenates `codec.getMessages(run.projection)` per Run in chain order to produce the flat TMessage[] the UI renders.

### Resolved group cache

Sibling group resolution is cached per `flattenNodes()` call using a `resolvedGroups` map. Once a sibling group is resolved to a selected runId, all other members of that group are skipped without re-resolving.

## Querying

The public `Tree` interface exposes:

| Method                  | Returns                                          |
| ----------------------- | ------------------------------------------------ |
| `getRunNode(runId)`     | The `RunNode` by runId                           |
| `getRunByMsgId(msgId)`  | The Run that owns a given msg-id                 |
| `getSiblingRuns(runId)` | All Runs in the sibling group containing `runId` |
| `hasSiblingRuns(runId)` | Whether the Run has alternative versions         |

The following are on the `View`, not the public `Tree` interface:

| Method                    | Returns                                          |
| ------------------------- | ------------------------------------------------ |
| `flattenNodes()`          | Linear Run chain following selected branches     |
| `getMessages()`           | Flat TMessage[] concatenated across visible Runs |
| `select(runId, index)`    | Switch to a different sibling at a fork point    |
| `getSelectedIndex(runId)` | Currently selected index in the sibling group    |

## Delete

`delete(runId)` removes a Run from all indexes. Children are **not** cascade-deleted - they become unreachable in `flattenNodes()` because their parent is no longer on the active path. The `_msgIdToRunId` entries pointing at the deleted Run are left dangling (overwritten on re-creation; harmless otherwise).

## What renders

The visible conversation is whatever `flattenNodes()` returns, concatenated through `codec.getMessages(run.projection)` per Run. Three rules combine to produce the Run chain:

1. **Parent reachability** — a Run is included only if its `parentRunId` is already on the current path. Root Runs (`parentRunId: undefined`) are always reachable.
2. **Sibling selection** — when multiple Runs share a `parentRunId` and are linked by a `forkOf` chain, exactly one is rendered. The View's selection (default: latest fork by `startSerial`) picks which.
3. **StartSerial order** — Runs that pass both checks are emitted in `startSerial`-ascending order. Optimistic null-`startSerial` Runs sort after all serial-bearing Runs.

Two practical patterns follow from these rules.

### Linear conversation

When each Run's `parentRunId` points at the prior Run in the conversation chain, the rendered chain is clean:

```
R1 (user "hi" → assistant "hello")
 └─ R2 (user "what's weather" → assistant "sunny", parentRunId=R1)
     └─ R3 (user "tomorrow?" → assistant "rainy",   parentRunId=R2)

view.flattenNodes()  → [R1, R2, R3]
view.getMessages()   → ["hi", "hello", "what's weather", "sunny", "tomorrow?", "rainy"]
```

This is the shape every fresh `view.sendMessage()` produces: each new turn opens a Run whose `parentRunId` is the tail Run of the visible branch.

### Edit-then-regenerate

When the user edits an earlier prompt, the edit publishes as a **new sibling Run** with the same `parentRunId` as the original and `forkOf` pointing at the user-message msg-id being edited. A fresh agent run produces the assistant response inside the new sibling Run. Both Runs stay in the tree; selection picks which branch is visible.

```
R1 (user "hi" → assistant "hello")
 │
 ├─ R2  (user "weather"  → assistant "sunny",   parentRunId=R1)
 │   └─ R4 (user "tomorrow?" → assistant "rainy", parentRunId=R2)
 │
 └─ R2' (user "forecast" → assistant "5-day…",  parentRunId=R1, forkOf={runId:R2, msgId:<R2's user-msg-id>})
     └─ R4' (user "follow-up" → assistant "...",  parentRunId=R2')

Sibling group at R1's children: [R2, R2']    selection default: R2' (latest)
R4 and R4' are NOT siblings — they have different parentRunIds, no forkOf link.

view.flattenNodes()   (default selection)               → [R1, R2', R4']
view.select(R2.runId, 0) (pick the original R2)
view.flattenNodes()                                     → [R1, R2,  R4]
```

R4 and R4' sit on separate branches gated by parent reachability:

- Select R2 → R4's parent (R2) is in the path → R4 renders; R4''s parent (R2') is not → R4' is hidden.
- Select R2' → R4''s parent (R2') is in the path → R4' renders; R4 is hidden.

Threading every descendant Run's `parentRunId` directly at the prior turn (not at some shared ancestor) is what gives `flattenNodes()` the reachability edges it needs to swap branches cleanly when selection changes.

### What goes wrong if parents are flat

If every descendant Run in the example above were parented to R1 (a shared ancestor) instead of its actual prior turn, the rendered chain for either selection would include both R4 and R4':

```
R1
 ├─ R2   (parentRunId=R1)
 ├─ R2'  (parentRunId=R1, forkOf=R2)
 ├─ R4   (parentRunId=R1)    ← flat parent
 └─ R4'  (parentRunId=R1)    ← flat parent

view.flattenNodes()  (R2' selected) → [R1, R2', R4, R4']
                                                ↑   ↑
                                                old new (both rendered)
```

R4 and R4' aren't a sibling group (no `forkOf` between them), so selection doesn't suppress either. Both pass parent reachability because their parent R1 is on the path regardless of which user-prompt sibling at R1's children level is selected. The visible conversation would show stale follow-up turns from an abandoned branch.

The send path's auto-parent rule (each new Run's `parentRunId` resolved from the visible branch's tail Run) is what keeps the first shape happening automatically. See [Wire protocol: branching headers](wire-protocol.md#branching-headers) for header semantics. See [History hydration](history.md) for how the tree is populated from channel history.
