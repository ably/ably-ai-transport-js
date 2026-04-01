# Review: conversation tree & decode history - internal considerations

Internal correctness, performance, and test coverage. Public API items are in `review-public-api-considerations.md`.

## 1. Conversation tree

### Header update is replace, not merge

`conversation-tree.ts:346–348`

Non-empty headers on upsert replace the entire headers object:

```typescript
if (Object.keys(headers).length > 0) {
  existing.node.headers = { ...headers };  // REPLACE, not merge
}
```

Currently safe because all callers pass full headers (streaming updates pass the accumulated `observer.headers`), but a future caller passing partial headers would silently destroy existing ones. Either change to merge semantics:

```typescript
existing.node.headers = { ...existing.node.headers, ...headers };
```

Or document the invariant that callers must always pass complete headers.

### `_getSiblingGroup` called unconditionally in `flattenNodes()`

`conversation-tree.ts:274`

For every node in `_sortedList`, `_getSiblingGroup()` runs even for non-forked nodes. The `resolvedGroups` cache avoids repeated selection but not repeated group computation. O(n·k) average, O(n²) worst case. Acceptable for expected conversation sizes (< 500 messages) but worth caching if that assumption changes.

### Three separate cycle guards for the same forkOf chain walk

`conversation-tree.ts:178`, `222`, `244`

`_getSiblingGroup`, `_isSiblingOf`, and `_getGroupRoot` each independently guard against forkOf cycles with their own `visited` set. Could be unified into a shared helper:

```typescript
private _followForkChain(startId: string): ConversationNode<TMessage> {
  const entry = this._nodeIndex.get(startId);
  if (!entry) return ...;
  let current = entry.node;
  const visited = new Set<string>([current.msgId]);
  while (current.forkOf) {
    if (visited.has(current.forkOf)) break;
    const target = this._nodeIndex.get(current.forkOf);
    if (!target || target.node.parentId !== current.parentId) break;
    current = target.node;
    visited.add(current.msgId);
  }
  return current;
}
```

## 2. Decode history

### O(n²) re-decode

`decode-history.ts:202`, `233`

`decodeAll()` re-decodes all accumulated messages from scratch on every page fetch and again in `buildResult`. For P pages with M messages: O(P²·M). The `fetchUntilLimit` → `buildResult` sequence also decodes redundantly (once at the end of the loop, once at the start of `buildResult`).

Short-term fix: cache the `decodeAll` result on `state` and invalidate when new pages are fetched:

```typescript
interface HistoryState<TEvent, TMessage> {
  // ...existing fields...
  cachedDecode: DecodedItem<TMessage>[] | undefined;
}

// In fetchUntilLimit, after pushing new items:
state.cachedDecode = undefined;

// In decodeAll or a wrapper:
if (state.cachedDecode) return state.cachedDecode;
const result = decodeAll(state);
state.cachedDecode = result;
return result;
```

### `rawMessages` grows unbounded

`decode-history.ts:38`

All raw Ably messages accumulate across pages and are held alive by the `buildResult` closure. For 1000 domain messages at ~10 wire messages each, this is ~10k objects. Manageable for expected sizes but worth documenting the upper bound.

### Positional header matching relies on Map insertion order

`decode-history.ts:160–176`

Turn header matching pairs `completedMessages` to `msgHeaders` entries by position:

```typescript
const headerEntries = [...turn.msgHeaders.entries()];
let headerIdx = 0;

for (const msg of turn.accumulator.completedMessages) {
  const entry = headerEntries[headerIdx];
  // ...
  headerIdx++;
}
```

Correct as long as Map insertion order matches accumulator completion order - which it does in the current protocol (messages complete in first-seen order). No test verifies this assumption.

### Default accumulator may be dead code

`decode-history.ts:82`

```typescript
const defaultAccumulator = state.codec.createAccumulator();
```

Messages without `x-ably-turn-id` go to a default accumulator. In the current protocol all domain messages have a turn ID. If this is a deliberate fallback, test it. If dead code, remove it (YAGNI).

## 3. Test coverage

### No dedicated `decode-history.test.ts`

Only covered through 5 shallow tests in `client-transport.test.ts` and 1 integration test. Missing:

- `decodeAll()` in isolation with fixed raw messages
- Turn spanning a page boundary (terminal event on page 2)
- Two interleaved concurrent turns (accumulator isolation)
- `hasNext()` / `next()` state transitions
- Header/serial pairing correctness
- Multi-page `fetchUntilLimit`

### Conversation tree test gaps

- **Deep fork chains** (A → B → C forkOf B forkOf A) - only 1-level forks tested
- **Explicit fork cycle guard** - code has guards in 3 places, no test exercises them
- **Delete of group root with remaining forks** - sibling group silently fragments, untested
- **Multiple root nodes** (2+ messages with no parent) - not tested
