# History and replay

`transport.view.loadOlder(limit)` loads conversation history from the Ably channel. A new client - after a page refresh, on a new device, or joining mid-conversation - can hydrate the full conversation from channel history without a separate database.

Without persistent history, page refresh means starting over. With AI Transport, messages are persisted on the Ably channel and decoded through the same codec used for live streaming.

## Loading history

```typescript
const view = transport.view;
await view.loadOlder(30);

// view.flattenNodes() - decoded messages including history, in chronological order
// Call loadOlder again to fetch more older messages
```

History messages are inserted into the transport's conversation tree and trigger an `'update'` notification on the view. After loading history, `transport.view.flattenNodes().map(n => n.message)` returns the combined history + live messages - flattened along the currently selected branch. If the history contains forks (from regeneration or editing), only the active branch is included. Use the conversation tree to navigate between branches (see [Conversation branching](branching.md)).

The `limit` parameter controls how many **complete domain messages** to return, not how many Ably wire messages to fetch. A single assistant message may span dozens of Ably messages (one per append). The implementation pages through Ably history until `limit` complete messages have been assembled.

## Gapless continuity

The client transport subscribes to the Ably channel **before** attaching. When you call `loadOlder()`, it uses `untilAttach` mode - fetching messages up to the point of attachment. This means there's no gap between history and the live subscription: every message is accounted for exactly once.

## React hook

`useView` provides message state with integrated history loading:

```typescript
import { useView } from '@ably/ai-transport/react';

// Auto-loads first page on mount (passing options = enabled)
const { nodes, hasOlder, loading, loadOlder } = useView(transport, { limit: 30 });

// nodes - TreeNode[] for the current branch
// hasOlder - are there older pages?
// loading - is a page being fetched?
// loadOlder() - load more older messages
```

Pass `null` or omit the options to disable auto-load:

```typescript
// Manual load only
const { nodes, hasOlder, loading, loadOlder } = useView(transport);
// ...later:
await loadOlder(30);
```

## Scroll-back pattern

Combine `useView` with a scroll sentinel for infinite scroll:

```typescript
const { nodes, hasOlder, loading, loadOlder } = useView(transport, { limit: 30 });

// In your message list
{hasOlder && (
  <button onClick={() => loadOlder()} disabled={loading}>
    {loading ? 'Loading...' : 'Load older messages'}
  </button>
)}
```

## How history interacts with branching

History messages carry the same `x-ably-parent` and `x-ably-fork-of` headers as live messages. When loaded, they're inserted into the conversation tree with their full branch structure intact. A client loading history sees the same tree of branches and can navigate siblings just like a client that was present for the original conversation.

Because the tree may contain multiple branches, the view's `flattenNodes()` returns only the messages along the currently selected path - not every message ever published. To see alternative branches, use `useTree` or the tree's `getSiblings()` / `select()` methods.

See [Conversation branching](branching.md) for the tree model.

## What history contains

History includes all messages published to the channel: user messages, assistant messages (with fully accumulated text), turn lifecycle events, and cancel signals. The decoder filters and reconstructs domain messages from this raw log.

Only **completed** messages appear in history results. A message is complete when its terminal event (finish, abort, or error) has been received. Partial messages from in-progress turns are not included in history pages, but will appear through the live subscription when they complete.

For the internal mechanics of history decoding - including the re-decode strategy, per-turn accumulators, and pagination - see [History hydration](../internals/history.md).
