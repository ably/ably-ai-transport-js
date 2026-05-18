# Conversation tree

The conversation tree (`src/core/transport/conversation-tree.ts`) materializes a branching conversation from a flat stream of Ably messages. It handles message ordering and sibling grouping for edit/regenerate forks. The tree is a pure data structure - it stores all nodes and their relationships, but selection state and navigation (`select()`, `getSelectedIndex()`) live on the View.

The tree is the single source of truth for conversation state. The view's `flattenNodes()` delegates to the tree's internal `flattenNodes()` with pagination filtering and branch selection.

## Ordering: serial-first

Ably assigns a [serial](glossary.md#serial-ably) - a lexicographically sortable string identifier - to every message on acceptance. The tree uses serial as the primary ordering mechanism:

- **Serial-bearing messages** sort lexicographically by serial
- **Null-serial messages** (optimistic inserts before [server relay](wire-protocol.md#optimistic-reconciliation)) sort after all serial-bearing messages, ordered among themselves by insertion sequence

Note that serial order is not necessarily delivery order - messages published concurrently from different connections may interleave in any order relative to each other. Serial order provides a stable, deterministic total order for the tree, but it reflects Ably's acceptance order rather than any single client's observation order. Parent headers ([`x-ably-parent`](wire-protocol.md#branching-headers)) are only structurally meaningful at branch points - for linear sequences, serial order is sufficient.

## Data structures

```
_nodeIndex:          Map<msgId, InternalNode>        Primary index
_sortedList:         InternalNode[]                  All nodes, sorted by serial
_parentIndex:        Map<parentId, Set<msgId>>       Children of each parent
_selections:         Map<groupRootId, index>         Selected sibling at each fork
_structuralVersion:  number                          Monotonic counter (see below)
```

Each `MessageNode` stores:

```typescript
{
  message: TMessage; // The domain message
  msgId: string; // From x-ably-msg-id
  parentId: string | undefined; // From x-ably-parent
  forkOf: string | undefined; // From x-ably-fork-of
  headers: Record<string, string>;
  serial: string | undefined; // Ably-assigned serial
}
```

## Upsert: the sole mutation

`upsert(msgId, message, headers, serial?)` is the only way to add or update messages:

**Insert (new msgId):**

1. Create a `MessageNode` from the message, headers, and serial
2. Add to the node index and parent index
3. Insert into the sorted list at the correct position (binary search for serial-bearing, append for null-serial)

**Update (existing msgId):**

1. Update the message content and headers in place
2. If a serial is provided and the existing node has no serial (optimistic → relay), promote the serial: remove from sorted list, re-insert at correct position

Serial promotion handles the common case where a client inserts an optimistic message (null serial), then the server publishes it to the channel (with serial). The node moves from the end of the sorted list to its correct serial-order position.

### Structural version

The tree maintains a `structuralVersion` counter (exposed via `TreeInternal`) that increments on changes affecting the `flattenNodes()` output structure - node inserts, deletions, and serial promotions (which reorder the sorted list). Content-only updates (replacing an existing node's message) do not increment the counter. The [View](message-lifecycle.md#cached-message-list) uses this to skip full tree walks during streaming - when only message content changed, the cached node list is still structurally valid.

## Sibling groups and fork chains

When a user calls `regenerate(msgId)` or `edit(msgId)`, the new message carries an [`x-ably-fork-of`](wire-protocol.md#branching-headers) header pointing to `msgId`. Messages that fork the same target (or transitively fork each other) form a **sibling group** - alternative messages at the same point in the conversation.

### Finding the group

To find the sibling group for a message:

1. Follow the `forkOf` chain to the **[group root](glossary.md#group-root)** - the original message that has no `forkOf` (or whose `forkOf` target has a different parent)
2. Collect all messages with the same `parentId` whose `forkOf` chain leads back to the group root
3. Sort siblings by serial (newest last)

Cycle detection guards against malformed `forkOf` chains.

### Selection

Each sibling group has a selected index (default: last, i.e. the most recent fork). Selection state is managed by the View - `view.select(msgId, index)` changes which sibling is active. The selection is stored by the group root's msgId.

## Flatten: producing the linear path

`flattenNodes()` walks the sorted list and produces the linear message sequence for the currently selected branches:

```
for each node in sorted order:
  1. Check parent reachability - is the node's parent on the current path?
     (Root messages with no parent are always reachable)
  2. Check sibling selection - if this node is in a sibling group,
     is it the selected sibling?
  3. If both pass: add to the path and mark this msgId as reachable
```

Messages that fail either check are skipped - they're on unselected branches. This produces a linear sequence that follows the currently selected forks through the conversation tree.

### Resolved group cache

Sibling group resolution is cached per `flattenNodes()` call using a `resolvedGroups` map. Once a sibling group is resolved to a selected msgId, all other members of that group are skipped without re-resolving.

## Querying

The public `Tree` interface exposes:

| Method               | Returns                                              |
| -------------------- | ---------------------------------------------------- |
| `getSiblings(msgId)` | All messages in the sibling group containing `msgId` |
| `hasSiblings(msgId)` | Whether the message has alternative versions         |
| `getNode(msgId)`     | The `MessageNode` by message ID                      |
| `getHeaders(msgId)`  | Headers for a specific message                       |

The following are on the `View`, not the public `Tree` interface:

| Method                    | Returns                                         |
| ------------------------- | ----------------------------------------------- |
| `flattenNodes()`          | Linear message list following selected branches |
| `select(msgId, index)`    | Switch to a different sibling at a fork point   |
| `getSelectedIndex(msgId)` | Currently selected index in the sibling group   |

## Delete

`delete(msgId)` removes a node from all indexes. Children are **not** cascade-deleted - they become unreachable in `flattenNodes()` because their parent is no longer on the active path. This preserves the ability to restore deleted messages if needed (e.g. undo).

## Example: regeneration fork

```
User: "What is 2+2?"        msgId: m1, parent: undefined
Assistant: "4"               msgId: m2, parent: m1
  → user regenerates m2
Assistant: "Four"            msgId: m3, parent: m1, forkOf: m2

Sibling group for m2: [m2, m3]
Selection default: index 1 (m3, the latest)

view.flattenNodes() → ["What is 2+2?", "Four"]
view.select(m2, 0)
view.flattenNodes() → ["What is 2+2?", "4"]
```

## What renders

The visible conversation is whatever `flattenNodes()` returns. Three rules combine to produce it:

1. **Parent reachability** - a node is included only if its `parentId` is already on the current path. Root nodes (no parent) are always reachable.
2. **Sibling selection** - when multiple nodes share a parent and are linked by a `forkOf` chain, exactly one is rendered. The View's selection (default: latest fork by serial) picks which.
3. **Serial order** - nodes that pass both checks are emitted in serial-ascending order. Optimistic null-serial nodes sort after all serial-bearing nodes.

Two practical patterns follow from these rules.

### Linear conversation

When every assistant message is parented to the user prompt that triggered it, the rendered path is a clean chain:

```
m1 (user "hi")
 └─ m2 (assistant "hello",         parent=m1)
     └─ m3 (user "what's weather", parent=m2)
         └─ m4 (assistant "sunny", parent=m3)

view.flattenNodes() → [m1, m2, m3, m4]
```

This is the shape the assistant-parent default in [`Run.pipe`](wire-protocol.md#how-x-ably-parent-is-resolved) produces: assistant messages parent under the user prompt the agent just consumed.

### Edit-then-regenerate

When the user edits a prompt, the edit publishes with the **same parent** as the original and `forkOf` pointing to it. A fresh run produces a new assistant message threaded under the edit. Both originals stay in the tree; selection picks which branch is visible.

```
m1 (user "hi")
 └─ m2 (assistant "hello",         parent=m1)
     ├─ m3  (user "weather",       parent=m2)
     │   └─ m4 (assistant "sunny", parent=m3)
     └─ m3' (user "forecast",      parent=m2, forkOf=m3)
         └─ m4' (assistant "5-day…", parent=m3')

Sibling group at m2: [m3, m3']      selection default: m3'
Sibling group at m3': []            (m4 is not a sibling of m4'; they
                                     have different parents)

view.flattenNodes() (default selection)        → [m1, m2, m3', m4']
view.select(m2, 0) (pick the original m3)
view.flattenNodes()                            → [m1, m2, m3,  m4]
```

m4 and m4' are **not** in a sibling group - they share no parent and there's no `forkOf` link between them. They sit on separate branches, gated by parent reachability:

- Select m3 → m4's parent (m3) is in the path → m4 renders; m4''s parent (m3') is not in the path → m4' is hidden.
- Select m3' → m4''s parent (m3') is in the path → m4' renders; m4 is hidden.

This is why threading assistants under their user prompt (not under the run anchor) matters - it gives `flattenNodes()` the reachability edges it needs to swap branches cleanly when selection changes.

### What goes wrong if parents are flat

If every assistant in the example above were parented to m2 (the run anchor) instead of its user prompt, the rendered output for either selection would include both m4 and m4':

```
m1
 └─ m2
     ├─ m3   (user "weather",       parent=m2)
     ├─ m3'  (user "forecast",      parent=m2, forkOf=m3)
     ├─ m4   (assistant "sunny",    parent=m2)    ← flat parent
     └─ m4'  (assistant "5-day…",   parent=m2)    ← flat parent

view.flattenNodes() (m3' selected) → [m1, m2, m3', m4, m4']
                                              ↑    ↑    ↑
                                              ok   old  new
```

m4 and m4' are still not a sibling group (no `forkOf` between them), so selection doesn't suppress one. Both pass parent reachability because their parent m2 is on the path regardless of which user-prompt sibling is selected. The visible conversation shows the old assistant reply for a prompt the user just edited away.

The assistant-parent default in `Run.pipe` (see [Branching headers](wire-protocol.md#how-x-ably-parent-is-resolved)) is what keeps the first shape happening automatically.

See [Wire protocol: branching headers](wire-protocol.md#branching-headers) for header semantics and where each parent value comes from. See [History hydration](history.md) for how the tree is populated from channel history.
