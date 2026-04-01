# Review: conversation tree & decode history - public API considerations

Focused on types and behaviours that become locked at 1.0.0. Internal-only items (performance, test coverage, docs) are in `review-internal-considerations.md`.

## 1. Public API shape

### `ConversationTree` exposes mutation methods to consumers

`types.ts:388`

`upsert()` and `delete()` are on the exported `ConversationTree` interface, reachable via `transport.getTree()`. Calling them bypasses the transport's bookkeeping (no notification emitted, no withheld-key tracking). Should split into a read-only public interface and a mutable internal one; removing methods after 1.0 is breaking.

### `ConversationNode.headers` exposes all transport protocol headers

`types.ts:335`

`headers: Record<string, string>` includes internal `x-ably-*` headers (`turn-id`, `stream-id`, `status`, etc.) alongside domain headers. Since `flattenNodes()` and `getNodes()` return full nodes on the default read path (including via `useConversationTree().nodes` in React), every header key becomes implicit public contract. The structured fields (`parentId`, `forkOf`, `serial`, `msgId`) already cover transport metadata - `headers` should be filtered to domain headers only.

## 2. Behavioural contracts

### `PaginatedMessages.next()` is unsafe for concurrent calls

`decode-history.ts:252`

`ClientTransport.history()` returns `PaginatedMessages<TMessage>` directly to the consumer. The `next()` closure captures mutable state (`returnedCount`, `lastAblyPage`); two concurrent calls race and can return overlapping pages. The `useHistory` React hook guards with `loadingRef`, but non-React consumers get no protection. Either add a reentrance guard that rejects with `Ably.ErrorInfo`, or document sequential-only.

### `LoadHistoryOptions.limit` is not validated

`decode-history.ts:294`

`limit ≤ 0` passes `wireLimit = 0` or negative to `channel.history()`, which is undefined behaviour. Should reject at the public boundary with `InvalidArgument`.

## 3. Implementation

### `flattenNodes()` / `getNode()` return mutable internal references

`conversation-tree.ts:293`

Returns the live internal `ConversationNode` objects - no defensive copy. A consumer mutating `node.headers` or `node.serial` silently corrupts the tree's sort order and branch logic. `getNodes()` and `useConversationTree().nodes` amplify this since they're the primary read path. Making `ConversationNode` fields `readonly` catches most mistakes at compile time; `Object.freeze()` on the headers object catches the rest at runtime.
