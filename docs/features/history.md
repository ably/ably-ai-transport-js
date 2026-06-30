# History and replay

`view.loadOlder(limit)` loads conversation history from the Ably channel. A new client - after a page refresh, on a new device, or joining mid-conversation - can hydrate the full conversation from channel history without a separate database.

Without persistent history, page refresh means starting over. With AI Transport, messages are persisted on the Ably channel and decoded through the same codec used for live streaming.

## Loading history

```typescript
const view = session.view;
const revealed = await view.loadOlder(30); // resolves to the newly-revealed page

// view.getMessages() - the full visible branch as CodecMessage<TMessage>[]
//   (each { codecMessageId, message }), oldest-first.
// `revealed` is the page this call prepended; it prefixes the next getMessages() result.
// Call loadOlder again to reveal more older messages.
```

`loadOlder(limit)` resolves to the page it revealed - the `CodecMessage<TMessage>[]` newly prepended to the window, oldest-first - or `[]` when channel history is exhausted (or a load is already in flight). The revealed page is the delta a caller inspects to drive its own stop criterion; the [database-hydration recipe](database-hydration.md) uses it to page back only as far as a stored seam.

History messages are inserted into the session's conversation tree and trigger an `'update'` notification on the view. After loading history, `view.getMessages()` returns the combined history + live messages - flattened across every visible Run along the currently selected branch. If the history contains forks (from regeneration or editing), only the active branch is included. Use the conversation tree to navigate between branches (see [Conversation branching](branching.md)).

The `limit` parameter controls how many older **messages** to reveal (default `10`), not how many Ably wire messages to fetch. The view pages through Ably history transparently until it has revealed `limit` more messages - fewer only when channel history is exhausted - then resolves to exactly that revealed page. How many wire messages each round-trip fetches is a separate, configurable concern (see [Page size](#page-size)).

## Gapless continuity

The client session subscribes to the Ably channel before any history call - the subscribe call itself implicitly attaches the channel (RTL7g), so the live listener is in place from the moment of attach. When you call `loadOlder()`, it uses `untilAttach` mode - fetching messages up to the point of attachment. This means there's no gap between history and the live subscription: every message is accounted for exactly once.

## Page size

`loadOlder`'s `limit` is how many messages are **revealed** to the view. Independently, the SDK fetches Ably history in pages of a fixed wire-message size, set by the `historyPageSize` option on `createClientSession` (and `createAgentSession`), default `100`. One round-trip usually covers several messages, since a streamed message spans many wire messages (create + appends + close).

```typescript
const session = createClientSession({ client, channelName, codec, historyPageSize: 200 });
```

Tune `historyPageSize` only to trade round-trips against per-fetch payload size; it does not change how many messages `loadOlder` reveals.

## React hook

`useView()` provides message state with integrated history loading:

```typescript
import { useView } from '@ably/ai-transport/react';

// Passing `limit` auto-loads the first page on mount.
const { messages, hasOlder, loading, loadError, loadOlder } = useView({ session, limit: 30 });

// messages - flat CodecMessage<TMessage>[] (each { codecMessageId, message }) concatenated across all visible Runs along the selected branch
// hasOlder - are there older pages?
// loading - is a page being fetched?
// loadError - the Ably.ErrorInfo from the most recent failed loadOlder, or undefined
// loadOlder() - load more older messages (takes no argument; uses the hook's `limit`)
```

Omit `limit` to disable auto-load:

```typescript
// Manual load only
const { messages, hasOlder, loading, loadOlder } = useView({ session });
// ...later:
await loadOlder();
```

## Scroll-back pattern

Combine `useView()` with a scroll sentinel for infinite scroll:

```typescript
const { messages, hasOlder, loading, loadOlder } = useView({ session, limit: 30 });

// In your message list
{hasOlder && (
  <button onClick={() => loadOlder()} disabled={loading}>
    {loading ? 'Loading...' : 'Load older messages'}
  </button>
)}
```

## How history interacts with branching

History messages carry the same `parent` and `fork-of` headers as live messages. When loaded, they're inserted into the conversation tree with their full branch structure intact. A client loading history sees the same tree of branches and can navigate siblings just like a client that was present for the original conversation.

Because the tree may contain multiple branches, the view renders only the nodes along the currently selected path — not every node ever published. To see alternative branches, use `useView()` or the view's `branchSelection(codecMessageId).select(index)` method.

See [Conversation branching](branching.md) for the tree model.

## What history contains

History includes all messages published to the channel: user messages, assistant messages (with fully accumulated text), run lifecycle events, and cancel signals. The decoder filters and reconstructs domain messages from this raw log.

Only **completed** messages appear in history results. A message is complete once both a start signal and a terminal signal — a `status` header of `complete` or `cancelled`, or a `discrete` message that starts and terminates in one wire — have been seen for its `codec-message-id`. Partial messages from in-progress runs are not included in history pages, but will appear through the live subscription when they complete.

For the internal mechanics of history decoding - including the re-decode strategy, per-Run projections, and pagination - see [History hydration](../internals/history.md).
