# History hydration

`decodeHistory()` (`src/core/transport/decode-history.ts`) loads conversation history from an Ably channel's history API and returns decoded domain messages. It handles the mismatch between Ably's newest-first history pagination and the decoder's requirement for chronological input.

## The problem

Ably's history API returns messages newest-first. The [decoder](decoder.md) needs messages oldest-first (chronological) because [stream accumulation](decoder.md#stream-tracker) depends on seeing the create before the appends. A single domain message may span many Ably [wire messages](wire-protocol.md#streamed-messages) (create + N appends + close), and a run's messages may span page boundaries.

Additionally, the `limit` parameter should control the number of complete **domain messages** returned, not the number of raw Ably messages fetched. A single domain message with 100 token deltas produces 100+ Ably messages.

## Strategy: count via headers, decode once

`decodeHistory()` collects raw Ably messages across all fetched pages but runs the full decoder exactly once per traversal. The fetch loop decides when to stop by scanning transport headers on newly-added messages - O(n) counter work across the whole traversal, regardless of how many pages are fetched.

1. Fetch a page of Ably history (newest-first)
2. Append raw messages to the collection
3. Scan the new messages' `x-ably-*` headers to update the [completion counter](#completion-counter)
4. If the counter shows enough completed domain messages, stop; otherwise fetch the next page and repeat
5. Once the loop exits, reverse the collection to chronological order and run the decoder over the full set

Decoding the full set at the end (rather than per page) is what lets the implementation handle runs that span page boundaries, interleaved concurrent runs, and the many-to-one wire-message-to-domain-message ratio without paying an O(n) re-decode cost per page.

## Completion counter

The fetch loop's stop condition uses three `Set<string>`s on `HistoryState`. Each time a page is fetched, the new messages are scanned and these sets are updated incrementally:

- `startedCodecMessageIds` - codec-message-ids for which the decoder will have content to work with.
- `terminatedCodecMessageIds` - codec-message-ids whose stream has a terminal wire signal.
- `completedCodecMessageIds` - the intersection. The loop reads `completedCodecMessageIds.size` to decide when to stop.

A codec-message-id is **started** when any of these is seen on a message carrying [`x-ably-codec-message-id`](wire-protocol.md#message-identity-x-ably-codec-message-id):

- `message.create` with `x-ably-discrete` - a discrete user or history message, started and terminated by the same wire message.
- `message.create`, `message.update`, or `message.append` with `x-ably-stream: "true"` - the decoder establishes a tracker for this serial via create or [first-contact](decoder.md#update-handling-first-contact-vs-prefix-match).

A codec-message-id is **terminated** when:

- `x-ably-discrete` is present on the create.
- `x-ably-status` is `"complete"` or `"cancelled"` on any later action.

Messages with `x-ably-amend` are skipped - amendments target an existing message rather than producing a new completion. Messages without `x-ably-codec-message-id` (run lifecycle events) are skipped too. `message.delete` is never a start signal: it clears the decoder's tracker and emits nothing.

Requiring both halves matters when a streaming run spans a page boundary. The terminal arrives in the newer (first-fetched) page while the start sits in an older page. Counting the terminal alone would stop the fetch loop prematurely - the decoder would have no stream state to resolve, and the message wouldn't make it into the result.

Accepting `message.update` and `message.append` as starts matters because Ably history can compact a live `create + append + ... + append{status:complete}` sequence into a single `message.update` with the accumulated data and terminal status - the decoder handles that via first-contact, and the counter has to recognise it or the loop pages past compacted runs without ever marking them complete.

The counter is an approximation, not a proof: a truncated history where every start signal for a codec-message-id has rolled off but a terminal survives will never complete that codec-message-id in the counter. The loop keeps fetching until it exhausts Ably pages, then returns whatever the decoder actually produced - which for this pathological case is nothing for that codec-message-id.

## Per-run accumulators

Messages are grouped by [`x-ably-run-id`](wire-protocol.md#transport-headers-x-ably). Each run gets its own [`MessageAccumulator`](codec-interface.md#accumulator) instance. Messages without a run IDs go to a default accumulator.

Each run needs a separate accumulator because the accumulator is stateful - it tracks in-progress messages, active streams, and part assembly. If events from concurrent runs were fed into a single accumulator, a text-delta from run A could be accumulated into run B's message, corrupting both. Isolation by run IDs ensures each accumulator builds only the messages belonging to its run.

After all wire messages have been decoded, the transport reads `completedMessages` (not `messages`) from each accumulator. Only messages whose streams have terminated appear in history results - partial messages at page boundaries are buffered until more pages are fetched. See [Accumulator](codec-interface.md#accumulator) for the distinction between `messages` and `completedMessages`.

## Pagination

`decodeHistory` itself paginates by completed domain messages; the `View` wraps it to paginate by **Runs**. `View.loadOlder(limit)` reveals up to `limit` Runs per call. The View loops `decodeHistory` pages (using an internal multiplier to amortise round-trips) until enough Runs are buffered, then withholds excess for subsequent calls.

The `limit` option on the lower-level `decodeHistory` still counts completed domain messages (not Runs) and is the contract documented below:

```typescript
await view.loadOlder(10);
// view.flattenNodes() returns the visible RunNode[] including up to 10
//   newly-revealed older Runs.
// view.getMessages() returns the concatenated flat message list across
//   all visible Runs.
// view.hasOlder - more history available
// view.loadOlder(10) - load more older Runs
```

### Wire limit multiplier

`decodeHistory` requests `limit * 10` Ably messages per page to account for the many-to-one ratio between wire and domain messages. This is a heuristic; a single assistant message with streaming may produce dozens of Ably messages, so fetching only `limit` Ably messages would almost never yield `limit` complete domain messages.

The View applies its own multiplier (`_RUN_TO_MESSAGE_FETCH_FACTOR = 3`) on top of this when requesting pages for `loadOlder(limit)`. Because the View paginates by **Runs** but `decodeHistory` paginates by **domain messages**, the factor amortises the typical messages-per-Run ratio (~2 for a user + assistant pair, with headroom for tool calls) so a single round-trip usually satisfies the Run-unit target before `_loadUntilVisible` has to fetch another page.

### Completed vs partial

Only completed messages appear in results. A message is complete when its [terminal event](glossary.md#terminal-event) (finish, abort, error) has been received. Partial messages (stream still in progress, or run spans a page boundary) are buffered internally and may complete on the next page fetch.

## Result shape

```typescript
interface HistoryItem<TMessage> {
  message: TMessage; // The decoded domain message
  headers: Record<string, string>; // Transport headers for tree identity and ordering
  serial: string; // Ably serial for tree ordering
}

interface HistoryPage<TMessage> {
  items: HistoryItem<TMessage>[]; // Completed items, chronological
  rawMessages: Ably.InboundMessage[]; // Raw Ably messages for this page
  hasNext(): boolean;
  next(): Promise<HistoryPage<TMessage> | undefined>;
}
```

Each `HistoryItem` pairs a decoded message with its canonical [transport headers](wire-protocol.md#transport-headers-x-ably) and Ably serial. The session uses these to seed the [conversation tree](conversation-tree.md#upsert-the-sole-mutation) with correct [branching metadata](wire-protocol.md#branching-headers) and serials.

`rawMessages` provides the raw Ably messages for this page, in chronological order. The client session uses these for its internal message log.

## Channel attach and untilAttach

`decodeHistory()` [attaches the channel](glossary.md#channel-attach-ably) (idempotent) and uses [`untilAttach: true`](glossary.md#untilattach-ably) on the history call. This guarantees no gap between historical messages and the live subscription - the history ends exactly where the subscription starts.

## Shared state across pages

The `HistoryState` object persists across `next()` calls within a single history traversal:

- `rawMessages` - all Ably messages collected across all pages
- `returnedCount` - how many completed domain messages have been returned
- `lastAblyPage` - cursor for Ably pagination
- `startedMsgIds` / `terminatedMsgIds` / `completedMsgIds` - the [completion counter](#completion-counter)
- `cachedDecode` / `cachedAtRawLength` - memoises the `decodeAll` result, keyed on `rawMessages.length` (append-only within a traversal, so length is a sufficient invalidation signal)

Each `next()` call either slices more completed messages from the cached decode, or fetches more Ably pages - which extends `rawMessages`, invalidates the cache, and triggers a fresh decode.

## Header and serial resolution

Each completed domain message needs its canonical transport headers and Ably serial for the conversation tree. The implementation tracks:

- **Per-run headers by codec-message-id** - the last-seen headers for each [`x-ably-codec-message-id`](wire-protocol.md#message-identity-x-ably-codec-message-id) within a run (closing appends override earlier headers, e.g. [status](wire-protocol.md#streamed-messages) changes from `"streaming"` to `"complete"`)
- **Discrete message headers** - captured when the decoder produces a `kind: 'message'` output
- **Serials** - from the first Ably message for each codec-message-id

These are paired with completed messages and packed into each `HistoryItem` alongside `message`.

See [Decoder](decoder.md) for how the decoder processes Ably messages into domain events. See [Conversation tree](conversation-tree.md) for how decoded messages are inserted into the tree using headers and serials from history. See [Codec interface](codec-interface.md) for the accumulator that builds complete messages from decoder outputs.
