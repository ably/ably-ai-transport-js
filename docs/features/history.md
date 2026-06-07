# History and replay

`view.loadOlder(limit)` loads conversation history from the Ably channel. A new client - after a page refresh, on a new device, or joining mid-conversation - can hydrate the full conversation from channel history without a separate database.

Without persistent history, page refresh means starting over. With AI Transport, messages are persisted on the Ably channel and decoded through the same codec used for live streaming.

## Loading history

```typescript
const view = session.view;
await view.loadOlder(30);

// view.flattenNodes() - the visible Run nodes including history, oldest-first.
// view.getMessages() - flat messages concatenated across visible Runs.
// Call loadOlder again to fetch more older Runs.
```

History messages are inserted into the session's conversation tree and trigger an `'update'` notification on the view. After loading history, `view.getMessages()` returns the combined history + live messages - flattened across every visible Run along the currently selected branch. If the history contains forks (from regeneration or editing), only the active branch is included. Use the conversation tree to navigate between branches (see [Conversation branching](branching.md)).

The `limit` parameter controls how many **Runs** to reveal, not how many messages or how many Ably wire messages to fetch. Each Run typically contributes more than one message (e.g. a user prompt + an assistant reply), so revealing `limit` Runs may add several messages to the flat list. The implementation pages through Ably history transparently until enough Runs are buffered.

## Gapless continuity

The client session subscribes to the Ably channel **before** attaching. When you call `loadOlder()`, it uses `untilAttach` mode - fetching messages up to the point of attachment. This means there's no gap between history and the live subscription: every message is accounted for exactly once.

## React hook

`useView()` provides message state with integrated history loading:

```typescript
import { useView } from '@ably/ai-transport/react';

// Auto-loads first page on mount (passing options = enabled)
const { nodes, messages, hasOlder, loading, loadOlder } = useView({ session, limit: 30 });

// nodes - RunNode[] for the current branch (one Run per turn)
// messages - flat CodecMessage<TMessage>[] (each { codecMessageId, message }) concatenated across all visible Runs
// hasOlder - are there older pages?
// loading - is a page being fetched?
// loadOlder() - load more older Runs
```

Pass `null` or omit the options to disable auto-load:

```typescript
// Manual load only
const { nodes, hasOlder, loading, loadOlder } = useView({ session });
// ...later:
await loadOlder(30);
```

## Scroll-back pattern

Combine `useView()` with a scroll sentinel for infinite scroll:

```typescript
const { nodes, hasOlder, loading, loadOlder } = useView({ session, limit: 30 });

// In your message list
{hasOlder && (
  <button onClick={() => loadOlder()} disabled={loading}>
    {loading ? 'Loading...' : 'Load older messages'}
  </button>
)}
```

## How history interacts with branching

History messages carry the same `parent` and `fork-of` headers as live messages. When loaded, they're inserted into the conversation tree with their full branch structure intact. A client loading history sees the same tree of branches and can navigate siblings just like a client that was present for the original conversation.

Because the tree may contain multiple branches, the view renders only the nodes along the currently selected path — not every node ever published. To see alternative branches, use `useView()` or the view's `branchSelection(codecMessageId)` / `selectSibling(codecMessageId, index)` methods.

See [Conversation branching](branching.md) for the tree model.

## What history contains

History includes all messages published to the channel: user messages, assistant messages (with fully accumulated text), run lifecycle events, and cancel signals. The decoder filters and reconstructs domain messages from this raw log.

Only **completed** messages appear in history results. A message is complete when its terminal event (finish, abort, or error) has been received. Partial messages from in-progress runs are not included in history pages, but will appear through the live subscription when they complete.

For the internal mechanics of history decoding - including the re-decode strategy, per-run accumulators, and pagination - see [History hydration](../internals/history.md).
