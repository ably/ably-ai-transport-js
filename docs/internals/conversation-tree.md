# Conversation tree

The conversation tree (`src/core/transport/tree.ts`) materializes a branching conversation as a forest of **nodes**. Each turn is two nodes: a client-owned **input node** (the user prompt, keyed by its `codec-message-id`, with no run id) and an agent-owned **reply run** (the streamed response, keyed by the agent-minted `run-id`, parented to the input node via `parentCodecMessageId`). The tree handles node ordering and sibling grouping for edit/regenerate forks. It is a data structure with codec wiring - it owns the per-node [TProjection](glossary.md#tprojection) and folds inbound events into it, but selection state and navigation (`branchSelection(id).select(index)`) live on the `ClientView`.

Reachability is kind-blind: it walks `parentCodecMessageId` edges (input node → prior reply run, reply run → its input node, seed input → prior input), so the client no longer needs the `run-id` to thread a turn. A reply run's `run-id` is minted by the agent and observed off `ai-run-start`; the input node's id is owned by the client at send time.

The tree is the single source of truth for conversation state. The View's visible-node computation delegates to the tree's internal `visibleNodes(selections)` with pagination filtering layered on top of the tree's branch selection.

Each node holds its own per-node projection: an input node folds the user prompt's input events; a reply run folds the assistant text, tool calls, tool outputs, and continuation text published under its `run-id`. The View walks the visible node chain (input nodes + reply runs) and concatenates each node's `codec.getMessages(node.projection)` to produce the flat message list the UI renders.

## Ordering: serial-first

Ably assigns a [serial](glossary.md#serial-ably) - a lexicographically sortable string identifier - to every message on acceptance. The tree keeps every node (input nodes and reply runs alike) in a single `_sortedNodes` list, sorted by each node's **sort serial** — a reply run's `startSerial` (the serial of the first observed message tagged with that run-id) or an input node's `serial`:

- **Serial-bearing nodes** sort lexicographically by sort serial
- **Null-serial nodes** (optimistic inserts before [server relay](wire-protocol.md#optimistic-reconciliation)) sort after all serial-bearing nodes, ordered among themselves by insertion sequence (`insertSeq`)

Note that serial order is not necessarily delivery order - messages published concurrently from different connections may interleave in any order. Serial order provides a stable, deterministic total order, reflecting Ably's acceptance order rather than any single client's observation order. Parent headers ([`parent`](wire-protocol.md#branching-headers)) are only structurally meaningful at branch points - for linear sequences, sort-serial order is sufficient.

## Data structures

A node's **primary key** (`nodeKey`) is a reply run's `runId` or an input node's `codecMessageId` (the client owns the input id before the agent mints a runId).

```
_nodeIndex:               Map<nodeKey, InternalNode>          Primary index (both kinds)
_codecMessageIdToNodeKey: Map<codecMessageId, nodeKey>        Secondary: any owned codec-message-id -> owning node key
_sortedNodes:             InternalNode[]                      All nodes, sorted by sort serial
_parentIndex:             Map<parentCodecMessageId|undefined, Set<nodeKey>>
                                                              Children keyed by raw structural parentCodecMessageId (roots under `undefined`)
_replyRunsByInput:        Map<inputCodecMessageId, Set<runId>> Reverse edge: input node -> its reply runs
_siblingCache:            Map<nodeKey, InternalNode[]>        Sibling-group cache, keyed against _structuralVersion
_seqCounter:              number                              Insertion-sequence source (insertSeq tiebreaker)
_structuralVersion:       number                              Monotonic counter (see below)
```

A `RunNode<TProjection>` stores:

```typescript
{
  kind: 'run';
  runId: string; // From run-id - primary key
  parentCodecMessageId: string | undefined; // The input node's codec-message-id (from `parent`)
  forkOf: string | undefined; // Resolved fork target's node key (from fork-of)
  regeneratesCodecMessageId: string | undefined; // From msg-regenerate; kept as a message-id, not resolved
  clientId: string; // From run-client-id - the client that started this Run
  invocationId: string; // Agent-minted invocation-id; '' until run-start arrives
  state: RunNodeState; // { status: 'active' | 'suspended' | 'complete' | 'cancelled' } | { status: 'error'; error: Ably.ErrorInfo }
  projection: TProjection; // Codec-folded per-Run state
  startSerial: string | undefined; // First observed message's serial
  endSerial: string | undefined; // run-suspend / run-end serial
}
```

An `InputNode<TProjection>` stores:

```typescript
{
  kind: 'input';
  codecMessageId: string; // From codec-message-id - primary key
  parentCodecMessageId: string | undefined; // The preceding reply run's codec-message-id (from `parent`)
  forkOf: string | undefined; // The edited prompt's codec-message-id (from fork-of)
  projection: TProjection; // Codec-folded per-input state
  serial: string | undefined; // First observed message's serial
}
```

Parenting is **kind-blind**: `parentCodecMessageId` names the structural parent by codec-message-id (an input node hangs off the preceding reply run; a reply run hangs off its input node), and `_parentKeyOf` resolves it through `_codecMessageIdToNodeKey` to the owning node's key.

## Apply: the two mutation entry points

The tree exposes two mutation methods on its internal interface (used by the session, not the UI):

### `applyMessage({ inputs, outputs }, headers, serial?)`

The entry point for every inbound channel message. The decoded events arrive split by wire direction — `inputs` (client-published, `ai-input`) and `outputs` (agent-published, `ai-output`). `applyMessage` first **classifies** the message:

- **Run-less user input** — no `run-id`, a `user`-role message carrying a `codec-message-id` and at least one input event — becomes an **input node** keyed by that codec-message-id (routed to `_applyInputMessage`).
- **Everything else** needs a `run-id` to route to a **reply run** keyed by that run-id (routed to `_applyRunMessage`). A wire with neither a run-id nor a qualifying user input is logged and skipped.

Both paths fold `inputs` first then `outputs` into the owning node's projection, maintain `_codecMessageIdToNodeKey`, and emit an `'output'` event carrying the message's outputs (empty for an input fold) plus routing metadata (`runId`, `inputCodecMessageId`, `codecMessageId`, `serial`). `applyMessage` emits `'update'` only when the apply changed the tree shape (a new node or a serial promotion bumps `_structuralVersion`); content-only folds leave it untouched.

A wire-only metadata carrier that decodes to **zero events** for a not-yet-known node (e.g. an `ait-regenerate` carrier) is skipped — its reply run is created later by run-start, which carries the parent/fork/regenerate metadata, so creating a phantom node here would inflate sibling counts.

The optimistic send path (client publishing a fresh user-message) calls `applyMessage` with an `undefined` serial. When the server relay arrives, the node's serial is promoted from null to a real serial (`_promoteSerial`) and it re-sorts. In `_applyRunMessage`, an optimistic reply run is reconciled with its serial-bearing echo by `codec-message-id` (not the wire run-id) when the run-id isn't yet indexed.

### Canonical fold order

A node's projection is folded in **canonical order** — wire messages ascending by serial, events within a wire in decode order — regardless of the order wires arrive in. The tree guarantees this so codecs never have to (see [the reducer contract](codec-interface.md#reducer-and-projection)). Each node keeps a per-wire **event log**: one entry per serial, holding that wire's decoded events. A wire that extends the log tail (the common in-order case) folds incrementally onto the existing projection; a wire that lands earlier in the log — a late cross-publisher delivery, or a history page applying an older message after a newer one — triggers a **refold**: a fresh `init()` replayed through the whole log in serial order. Because the reducer is pure, the rebuilt projection matches one that had received the wires in order, and last-writer-wins falls out for free.

Two guards keep the log honest:

- **Whole-wire replays** (a second hydration, a remounted View, an agent history re-walk) are dropped by a per-entry high-water-mark over `Message.version.serial`, so a re-delivered wire records and folds nothing.
- **Optimistic seeds** fold into the projection but not the log; the first serial-bearing wire (the echo) refolds the node from the log alone, discarding the seed — so an optimistic insert and its server relay never duplicate.

The log is bounded: a run node's log is dropped once the run is terminal, its `ai-run-start` has been observed (the run's serial floor, so no older history page can still add to the node), and a reorder window has lapsed on the tree's logical clock (the max Ably message timestamp seen). Input-node logs are never swept.

### `applyRunLifecycle(event)`

Handles `ai-run-start`, `ai-run-suspend`, `ai-run-resume`, and `ai-run-end` wire events (decoded into a `RunLifecycleEvent` whose `type` is `start` / `suspend` / `resume` / `end`). The event carries its own channel `serial`. Run-start creates the reply run if missing (else sets `state.status` to `'active'`), promotes `startSerial` from the event's serial, and backfills structural metadata (`parentCodecMessageId`, `forkOf`, `regeneratesCodecMessageId`) and the agent-minted `invocationId` onto an optimistic / wire-created node — the run-start is the canonical source. Run-suspend sets `state.status` to `'suspended'` and records `endSerial`, but keeps the run live so a resume under the same `runId` re-activates it. Run-resume re-activates a suspended run (`state.status` back to `'active'`) without touching its structure or serials — a pure re-entry; it is a no-op for an unknown, already-active, or terminal run. Run-end sets `state` to the end reason, carrying the terminal `error` when the reason is `'error'`, and `endSerial` from the event's serial. Always emits a `'run'` event to subscribers, then `'update'` only when the event changed the tree shape (only run-start can).

### Structural version

The tree maintains a `_structuralVersion` counter (exposed via `TreeInternal`) that increments on changes affecting `visibleNodes()`'s output structure - node insertions, deletions, serial promotions (which reorder `_sortedNodes`), and run-start metadata backfill. **Projection-only updates do not bump the counter**: streaming deltas update an existing node's projection in place, observable via the `'output'` event instead. The tree uses this distinction to emit `'update'` only on structural change, so streaming deltas never trigger a View tree walk. The sibling-group cache (`_siblingCache`) is keyed against this counter — any topology mutation invalidates it on the next lookup.

## Sibling groups and fork chains

Sibling grouping is **kind-split** - an edit produces a sibling input node, a regenerate produces a sibling reply run:

- **Edit (`edit(msgId)`)**: a new **input node** whose `forkOf` points at the input node being replaced. Input nodes that fork the same target (or transitively fork each other) form a sibling group of edit versions.
- **Regenerate (`regenerate(msgId)`)**: a new **reply run** parented to the same input node as the original. Reply runs sharing a `parentCodecMessageId` are the regenerate group - no `forkOf` is stamped on a regenerate run, since sharing the input-node parent already groups them.

A sibling group never mixes kinds.

### Finding the group

To find the sibling group for a node:

1. Narrow on `kind`. For a reply run, the group is the reply runs sharing its `parentCodecMessageId`; for an input node, follow the `forkOf` chain to the **[group root](glossary.md#group-root)** - the original input node with no `forkOf` (or whose `forkOf` target has a different parent).
2. Collect the members for that kind (same input-node parent for runs; same `forkOf` chain for inputs).
3. Sort siblings by sort serial (oldest first; original at index 0).

Cycle detection guards against malformed `forkOf` chains. The result is cached in `_siblingCache` against the queried key and every member of the group.

### Selection

Each sibling group has a selected node (default: the latest sibling). Selection state is managed by the `ClientView` - `view.branchSelection(codecMessageId).select(index)` changes which sibling is active. The selection is stored by the group root's key (`getGroupRoot(key)`): for an input node the earliest fork-of ancestor, for a reply run the oldest same-parent run (the original reply).

## Visible nodes: producing the visible chain

`visibleNodes(selections)` walks `_sortedNodes` and produces the linear node chain (input nodes + reply runs) for the currently selected branches:

```
for each node in sort-serial order:
  1. Check parent reachability (kind-blind) - resolve parentCodecMessageId
     to its owning node's key; is that key in the current path?
     (Root nodes with undefined parentCodecMessageId are always reachable)
  2. Check sibling selection - if this node is in a sibling group,
     is it the selected member? (selections is keyed by group root;
     missing entry defaults to the latest sibling)
  3. If both pass: add the node's key to the path and emit the node
```

Nodes that fail either check are skipped - they're on unselected branches. The View then concatenates `codec.getMessages(node.projection)` per node in chain order to produce the flat `CodecMessage<TMessage>[]` the UI renders.

### Resolved group cache

Sibling group resolution is cached per `visibleNodes()` call using a `resolvedGroups` map (group-root key → selected member key). Once a group is resolved to a selected member, all other members are skipped without re-resolving.

## Querying

The public `Tree` interface exposes:

| Method                        | Returns                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `getRunNode(runId)`           | The `RunNode` by runId, or `undefined`                                                         |
| `getNodeByCodecMessageId(id)` | The `ConversationNode` (`InputNode \| RunNode`) that owns a codec-message-id; narrow on `kind` |
| `getSiblingNodes(key)`        | The sibling group (edit versions for an input node, regenerate runs for a reply run)           |

`TreeInternal` (consumed by the View / session, not public) additionally exposes `visibleNodes(selections)`, `getGroupRoot(key)`, `getReplyRuns(inputCodecMessageId)`, `getNode(key)`, `applyMessage`, `applyRunLifecycle`, `delete(key)`, and `emitAblyMessage`.

The following are on the view, not the `Tree`. `getMessages()` is on the read-only `View` base (the surface the agent's `run.view` also exposes); branch navigation is on the client's `ClientView`:

| Method                                      | Surface      | Returns                                                                |
| ------------------------------------------- | ------------ | ---------------------------------------------------------------------- |
| `getMessages()`                             | `View`       | Flat `CodecMessage<TMessage>[]` concatenated across visible nodes      |
| `branchSelection(codecMessageId)`           | `ClientView` | The `BranchHandle` (siblings, index, selected, `select`) for a message |
| `branchSelection(codecMessageId).select(i)` | `ClientView` | Switch to a different sibling at a fork point                          |

## Delete

`delete(key)` (where `key` is a node key — a runId or an input node's codec-message-id) removes a node from `_nodeIndex`, `_parentIndex`, `_sortedNodes`, and the reply→input reverse edge. Children are **not** cascade-deleted - they become unreachable in `visibleNodes()` because their parent is no longer on the active path. The `_codecMessageIdToNodeKey` entries pointing at the deleted node are left dangling (overwritten on re-creation; harmless otherwise). `delete` bumps `_structuralVersion` and emits `'update'`.

## What renders

The visible conversation is whatever `visibleNodes()` returns, concatenated through `codec.getMessages(node.projection)` per node. Each turn is **two nodes** — an input node `M` (the user prompt) and its reply run `R` — threaded by `parentCodecMessageId`: `M` hangs off the prior turn's reply run, and `R` hangs off `M`. Three rules combine to produce the chain:

1. **Parent reachability** (kind-blind) — a node is included only if its `parentCodecMessageId` resolves to a node key already on the current path. Root nodes (`parentCodecMessageId: undefined`) are always reachable.
2. **Sibling selection** — edit versions (sibling input nodes via `forkOf`) and regenerate variants (sibling reply runs sharing an input parent) collapse to exactly one member. The View's selection (default: latest by sort serial) picks which.
3. **Sort-serial order** — nodes that pass both checks are emitted in sort-serial-ascending order. Optimistic null-serial nodes sort after all serial-bearing nodes.

Two practical patterns follow from these rules.

### Linear conversation

When each turn's input node hangs off the prior reply run, the rendered chain is clean:

```
M1 (user "hi")   ←─ R1 (assistant "hello", parent=M1)
M2 (user "what's weather", parent=R1) ←─ R2 (assistant "sunny", parent=M2)
M3 (user "tomorrow?",      parent=R2) ←─ R3 (assistant "rainy", parent=M3)

view.getMessages()   → 6 { codecMessageId, message } pairs, message content:
                       ["hi", "hello", "what's weather", "sunny", "tomorrow?", "rainy"]
```

This is the shape every fresh `view.send()` produces: the new input node's `parent` is the codec-message-id of the visible branch's tail message, and the agent mints a reply run parented to that input node.

### Edit-then-regenerate

When the user edits an earlier prompt, `edit()` publishes a **new sibling input node** with the same `parent` as the original and `forkOf` pointing at the input node's codec-message-id being edited. The agent mints a fresh reply run parented to the new input node. Both input nodes (and their reply runs) stay in the tree; selection picks which branch is visible.

```
M1 (user "hi") ←─ R1 (assistant "hello", parent=M1)
 │
 ├─ M2  (user "weather",  parent=R1) ←─ R2 (assistant "sunny", parent=M2)
 │   └─ M4 (user "tomorrow?", parent=R2) ←─ R4 (assistant "rainy", parent=M4)
 │
 └─ M2' (user "forecast", parent=R1, forkOf=M2) ←─ R2' (assistant "5-day…", parent=M2')
     └─ M4' (user "follow-up", parent=R2') ←─ R4' (assistant "...", parent=M4')

Sibling group at R1's input children: [M2, M2']   selection default: M2' (latest)
M4 and M4' are NOT siblings — different parents, no forkOf link.

view.getMessages()   (default selection)           → M1, R1, M2', R2', M4', R4'
view.branchSelection(M2's id).select(0)  (pick the original)
view.getMessages()                                 → M1, R1, M2,  R2,  M4,  R4
```

M4 and M4' sit on separate branches gated by parent reachability:

- Select M2 → M4's parent chain (R2 → M2) is on the path → M4/R4 render; M4''s parent R2' is not → M4'/R4' are hidden.
- Select M2' → M4''s parent chain (R2' → M2') is on the path → M4'/R4' render; M4/R4 are hidden.

(Regenerate is the mirror image: `regenerate()` produces a new reply run sharing the original's input-node parent, so the regenerate group is the same-parent reply runs and selection swaps which run renders in that assistant slot.)

Threading every descendant turn's `parent` directly at the prior turn (not at some shared ancestor) is what gives `visibleNodes()` the reachability edges it needs to swap branches cleanly when selection changes.

### What goes wrong if parents are flat

If every descendant input node were parented to R1 (a shared ancestor) instead of its actual prior reply run, the rendered chain for either selection would include both M4 and M4':

```
M1 ←─ R1
 ├─ M2  (parent=R1) ←─ R2
 ├─ M2' (parent=R1, forkOf=M2) ←─ R2'
 ├─ M4  (parent=R1)    ← flat parent ←─ R4
 └─ M4' (parent=R1)    ← flat parent ←─ R4'

view.getMessages()  (M2' selected) → M1, R1, M2', R2', M4, R4, M4', R4'
                                                          ↑           ↑
                                                          old         new (both rendered)
```

M4 and M4' aren't a sibling group (no `forkOf` between them), so selection doesn't suppress either. Both pass parent reachability because R1 is on the path regardless of which prompt sibling is selected. The visible conversation would show stale follow-up turns from an abandoned branch.

The send path's auto-parent rule (each new input node's `parent` resolved from the visible branch's tail message) is what keeps the first shape happening automatically. See [Wire protocol: branching headers](wire-protocol.md#branching-headers) for header semantics. See [History hydration](history.md) for how the tree is populated from channel history.
