# History hydration

`decodeHistory` (`src/core/transport/decode-history.ts`) loads conversation history from an Ably channel's history API and returns decoded domain messages. It handles the mismatch between Ably's newest-first history pagination and the decoder's requirement for chronological input.

## The problem

Ably's history API returns messages newest-first. The [decoder](decoder.md) needs messages oldest-first (chronological) because [stream accumulation](decoder.md#stream-tracker) depends on seeing the create before the appends. A single domain message may span many Ably [wire messages](wire-protocol.md#streamed-messages) (create + N appends + close), and a turn's messages may span page boundaries.

Additionally, the `limit` parameter should control the number of complete **domain messages** returned, not the number of raw Ably messages fetched. A single domain message with 100 token deltas produces 100+ Ably messages.

## Strategy: collect and re-decode

Rather than trying to decode pages incrementally, `decodeHistory` collects all raw Ably messages and re-decodes the full set from scratch after each page fetch:

1. Fetch a page of Ably history (newest-first)
2. Append raw messages to the collection
3. Reverse the collection to chronological order
4. Create a fresh decoder and decode all messages from the beginning
5. Count completed domain messages
6. If not enough, fetch the next page and repeat from step 2

This approach is simple and correct: it handles turns that span page boundaries, interleaved concurrent turns, and the many-to-one wire-message-to-domain-message ratio.

## Per-turn accumulators

Messages are grouped by [`x-ably-turn-id`](wire-protocol.md#transport-headers-x-ably). Each turn gets its own [`MessageAccumulator`](codec-interface.md#accumulator) instance. Messages without a turn ID go to a default accumulator.

Each turn needs a separate accumulator because the accumulator is stateful - it tracks in-progress messages, active streams, and part assembly. If events from concurrent turns were fed into a single accumulator, a text-delta from turn A could be accumulated into turn B's message, corrupting both. Isolation by turn ID ensures each accumulator builds only the messages belonging to its turn.

After all wire messages have been decoded, the transport reads `completedMessages` (not `messages`) from each accumulator. Only messages whose streams have terminated appear in history results - partial messages at page boundaries are buffered until more pages are fetched. See [Accumulator](codec-interface.md#accumulator) for the distinction between `messages` and `completedMessages`.

## Pagination

The `limit` option controls how many completed domain messages appear in each page of results:

```typescript
await transport.view.loadOlder(10);
// view.flattenNodes() returns up to 10 completed messages
// view.hasOlder - more history available
// view.loadOlder(10) - load more older messages
```

### Wire limit multiplier

The implementation requests `limit * 10` Ably messages per page to account for the many-to-one ratio. This is a heuristic - a single assistant message with streaming may produce dozens of Ably messages, so fetching only `limit` Ably messages would almost never yield `limit` complete domain messages.

### Completed vs partial

Only completed messages appear in results. A message is complete when its [terminal event](glossary.md#terminal-event) (finish, abort, error) has been received. Partial messages (stream still in progress, or turn spans a page boundary) are buffered internally and may complete on the next page fetch.

## Result shape

```typescript
interface PaginatedMessages<TMessage> {
  items: TMessage[]; // Completed messages, chronological
  itemHeaders?: Record<string, string>[]; // Transport headers per message
  itemSerials?: string[]; // Ably serial per message
  rawMessages?: Ably.InboundMessage[]; // Raw Ably messages for this page
  hasNext(): boolean;
  next(): Promise<PaginatedMessages<TMessage> | undefined>;
}
```

`itemHeaders` and `itemSerials` are parallel arrays - `itemHeaders[i]` contains the [transport headers](wire-protocol.md#transport-headers-x-ably) for `items[i]`. The transport uses these to seed the [conversation tree](conversation-tree.md#upsert-the-sole-mutation) with correct [branching metadata](wire-protocol.md#branching-headers) and serials.

`rawMessages` provides the raw Ably messages for this page, in chronological order. The client transport uses these for its internal message log.

## Channel attach and untilAttach

`decodeHistory` [attaches the channel](glossary.md#channel-attach-ably) (idempotent) and uses [`untilAttach: true`](glossary.md#untilattach-ably) on the history call. This guarantees no gap between historical messages and the live subscription - the history ends exactly where the subscription starts.

## Shared state across pages

The `HistoryState` object persists across `next()` calls within a single history traversal:

- `rawMessages` - all Ably messages collected across all pages
- `returnedCount` - how many completed domain messages have been returned
- `lastAblyPage` - cursor for Ably pagination

Each `next()` call either slices more completed messages from the already-decoded set, or fetches more Ably pages and re-decodes.

## Header and serial resolution

Each completed domain message needs its canonical transport headers and Ably serial for the conversation tree. The implementation tracks:

- **Per-turn headers by msg-id** - the last-seen headers for each [`x-ably-msg-id`](wire-protocol.md#message-identity-x-ably-msg-id) within a turn (closing appends override earlier headers, e.g. [status](wire-protocol.md#streamed-messages) changes from `"streaming"` to `"finished"`)
- **Discrete message headers** - captured when the decoder produces a `kind: 'message'` output
- **Serials** - from the first Ably message for each msg-id

These are matched to completed messages and returned as parallel arrays alongside `items`.

See [Decoder](decoder.md) for how the decoder processes Ably messages into domain events. See [Conversation tree](conversation-tree.md) for how decoded messages are inserted into the tree using headers and serials from history. See [Codec interface](codec-interface.md) for the accumulator that builds complete messages from decoder outputs.
