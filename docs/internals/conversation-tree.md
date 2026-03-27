# Conversation tree

The conversation tree (`src/core/transport/client/conversation-tree.ts`) materializes a branching conversation from a flat stream of Ably messages. It handles message ordering, sibling grouping for edit/regenerate forks, and branch selection - producing a linear message list via `flatten()` that represents the currently selected conversation path.

The tree is the single source of truth for conversation state. The transport's `getMessages()` delegates directly to `tree.flatten()`.

## Ordering: serial-first

Ably assigns a [serial](glossary.md#serial-ably) - a lexicographically sortable string identifier - to every message on acceptance. The tree uses serial as the primary ordering mechanism:

- **Serial-bearing messages** sort lexicographically by serial
- **Null-serial messages** (optimistic inserts before [server relay](wire-protocol.md#optimistic-reconciliation)) sort after all serial-bearing messages, ordered among themselves by insertion sequence

Note that serial order is not necessarily delivery order - messages published concurrently from different connections may interleave in any order relative to each other. Serial order provides a stable, deterministic total order for the tree, but it reflects Ably's acceptance order rather than any single client's observation order. Parent headers ([`x-ably-parent`](wire-protocol.md#branching-headers)) are only structurally meaningful at branch points - for linear sequences, serial order is sufficient.

## Data structures

```
_nodeIndex:     Map<msgId, InternalNode>        Primary index
_codecKeyIndex: Map<codecKey, msgId>            Secondary: codec message key → msgId
_sortedList:    InternalNode[]                  All nodes, sorted by serial
_parentIndex:   Map<parentId, Set<msgId>>       Children of each parent
_selections:    Map<groupRootId, index>         Selected sibling at each fork
```

Each `ConversationNode` stores:

```typescript
{
  message: TMessage;              // The domain message
  msgId: string;                  // From x-ably-msg-id
  parentId: string | undefined;   // From x-ably-parent
  forkOf: string | undefined;     // From x-ably-fork-of
  headers: Record<string, string>;
  serial: string | undefined;     // Ably-assigned serial
}
```

## Upsert: the sole mutation

`upsert(msgId, message, headers, serial?)` is the only way to add or update messages:

**Insert (new msgId):**
1. Create a `ConversationNode` from the message, headers, and serial
2. Add to the node index and parent index
3. Insert into the sorted list at the correct position (binary search for serial-bearing, append for null-serial)

**Update (existing msgId):**
1. Update the message content and headers in place
2. If a serial is provided and the existing node has no serial (optimistic → relay), promote the serial: remove from sorted list, re-insert at correct position

Serial promotion handles the common case where a client inserts an optimistic message (null serial), then the server publishes it to the channel (with serial). The node moves from the end of the sorted list to its correct serial-order position.

## Sibling groups and fork chains

When a user calls `regenerate(msgId)` or `edit(msgId)`, the new message carries an [`x-ably-fork-of`](wire-protocol.md#branching-headers) header pointing to `msgId`. Messages that fork the same target (or transitively fork each other) form a **sibling group** - alternative messages at the same point in the conversation.

### Finding the group

To find the sibling group for a message:

1. Follow the `forkOf` chain to the **[group root](glossary.md#group-root)** - the original message that has no `forkOf` (or whose `forkOf` target has a different parent)
2. Collect all messages with the same `parentId` whose `forkOf` chain leads back to the group root
3. Sort siblings by serial (newest last)

Cycle detection guards against malformed `forkOf` chains.

### Selection

Each sibling group has a selected index (default: last, i.e. the most recent fork). `select(msgId, index)` changes which sibling is active. The selection is stored by the group root's msgId.

## Flatten: producing the linear path

`flatten()` walks the sorted list and produces the linear message sequence for the currently selected branches:

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

Sibling group resolution is cached per `flatten()` call using a `resolvedGroups` map. Once a sibling group is resolved to a selected msgId, all other members of that group are skipped without re-resolving.

## Querying

| Method | Returns |
|---|---|
| `flatten()` | Linear message list following selected branches |
| `getSiblings(msgId)` | All messages in the sibling group containing `msgId` |
| `hasSiblings(msgId)` | Whether the message has alternative versions |
| `getSelectedIndex(msgId)` | Currently selected index in the sibling group |
| `getNode(msgId)` | The `ConversationNode` by msg-id |
| `getNodeByKey(key)` | The `ConversationNode` by [codec message key](codec-interface.md#the-codec-interface) |
| `getHeaders(msgId)` | Headers for a specific message |

## Delete

`delete(msgId)` removes a node from all indexes. Children are **not** cascade-deleted - they become unreachable in `flatten()` because their parent is no longer on the active path. This preserves the ability to restore deleted messages if needed (e.g. undo).

## Example: regeneration fork

```
User: "What is 2+2?"        msgId: m1, parent: undefined
Assistant: "4"               msgId: m2, parent: m1
  → user regenerates m2
Assistant: "Four"            msgId: m3, parent: m1, forkOf: m2

Sibling group for m2: [m2, m3]
Selection default: index 1 (m3, the latest)

flatten() → ["What is 2+2?", "Four"]
select(m2, 0)
flatten() → ["What is 2+2?", "4"]
```

See [Wire protocol](wire-protocol.md) for the branching headers (`x-ably-parent`, `x-ably-fork-of`). See [History hydration](history.md) for how the tree is populated from channel history.
