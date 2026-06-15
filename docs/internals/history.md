# History hydration

`loadHistory()` (`src/core/transport/load-history.ts`) loads conversation history from an Ably channel's history API and returns the **raw wire messages** as a paginated `HistoryPage`. It does **not** decode: it pages back through Ably history until enough complete messages are present, then hands the raw Ably messages (oldest-first) to the caller. The [View](client-session.md) re-decodes them into the [Tree](conversation-tree.md) itself, so `loadHistory` only needs a cheap, header-based completion counter to decide when to stop paging - the [decoder](decoder.md) never runs here.

## The problem

Ably's history API returns messages newest-first. The View's decode replay needs messages oldest-first (chronological) because [stream accumulation](decoder.md#stream-tracker) depends on seeing the create before the appends. A single domain message may span many Ably [wire messages](wire-protocol.md#streamed-messages) (create + N appends + close), and a run's messages may span page boundaries.

Additionally, the `limit` parameter should control the number of complete **messages** returned, not the number of raw Ably messages fetched. A single message with 100 token deltas produces 100+ Ably messages.

## Strategy: count via headers, never decode

`loadHistory()` collects raw Ably messages across all fetched pages and decides when to stop by scanning transport headers on newly-added messages - O(n) counter work across the whole traversal, regardless of how many pages are fetched. The decoder is never run in `loadHistory`; the caller (the View) re-decodes the returned raw wires.

1. Fetch a page of Ably history (newest-first)
2. Append raw messages to the collection
3. Scan the new messages' transport headers to update the [completion counter](#completion-counter)
4. If the counter shows enough completed messages, stop; otherwise fetch the next page and repeat
5. When building a page result, reverse the new raw messages to chronological order and return them to the caller

Counting via headers (rather than decoding per page) is what lets the implementation handle runs that span page boundaries, interleaved concurrent runs, and the many-to-one wire-message-to-domain-message ratio without paying an O(n) decode cost per page - the decode happens once, in the View, over the returned raw wires.

## Completion counter

The fetch loop's stop condition uses three `Set<string>`s on `HistoryState`. Each time a page is fetched, `countNewCompletions()` scans the new messages and updates these sets incrementally:

- `startedCodecMessageIds` - codec-message-ids for which the decoder will have content to work with.
- `terminatedCodecMessageIds` - codec-message-ids whose stream has a terminal wire signal.
- `completedCodecMessageIds` - the intersection (both started AND terminated). The loop reads `completedCodecMessageIds.size` to decide when to stop.

A codec-message-id is **started** when any of these is seen on a message carrying [`codec-message-id`](wire-protocol.md#message-identity-codec-message-id):

- `message.create` with `discrete` - a discrete user or history message, started and terminated by the same wire message.
- `message.create`, `message.update`, or `message.append` with `stream: "true"` - the decoder establishes a tracker for this serial via create or [first-contact](decoder.md#update-handling-first-contact-vs-prefix-match).

A codec-message-id is **terminated** when:

- `discrete` is present on the create.
- `status` is `"complete"` or `"cancelled"` on any later action.

Amend-class wire messages (events targeting an existing message via `codec-message-id`) flow through the same counter - the Sets naturally dedup, so a tool-output amend on an already-seen codec-message-id is idempotent. Messages without `codec-message-id` (run lifecycle events) are skipped. `message.delete` is never a start signal: it clears the decoder's tracker and emits nothing.

Requiring both halves matters when a streaming run spans a page boundary. The terminal arrives in the newer (first-fetched) page while the start sits in an older page. Counting the terminal alone would stop the fetch loop prematurely - the decoder would have no stream state to resolve, and the message wouldn't make it into the result.

Accepting `message.update` and `message.append` as starts matters because Ably history can compact a live `create + append + ... + append{status:complete}` sequence into a single `message.update` with the accumulated data and terminal status - the decoder handles that via first-contact, and the counter has to recognise it or the loop pages past compacted runs without ever marking them complete.

The counter is an approximation, not a proof: a truncated history where every start signal for a codec-message-id has rolled off but a terminal survives will never complete that codec-message-id in the counter. The loop keeps fetching until it exhausts Ably pages, then returns whatever the decoder actually produced - which for this pathological case is nothing for that codec-message-id.

## Decoding happens in the View, not here

`loadHistory` returns only raw wires - it never folds them into messages. The [View](client-session.md) re-decodes the returned raw wires into the [Tree](conversation-tree.md) via the shared `applyWireMessage` primitive (`src/core/transport/decode-fold.ts`), which classifies each wire as run-lifecycle or codec-decoded and applies it. The Tree groups events by their owning node — reply runs by [`run-id`](wire-protocol.md#transport-headers), run-less input nodes by `codec-message-id` — and folds each node's events into its own opaque per-node `TProjection` via the codec's [`Reducer`](codec-interface.md#reducer-and-projection) half (`init()` / `fold()`).

Folding per Run is what keeps concurrent runs isolated: a text-delta from run A is folded into run A's projection, never run B's. Partial messages at page boundaries simply contribute to a projection that completes once a later page supplies the rest of the run's wires.

## Pagination

`loadHistory` itself paginates by completed messages; the `View` wraps it to paginate by **Runs**. `View.loadOlder(limit)` (default `100`) reveals up to `limit` Runs per call. The View loops `loadHistory` pages (using an internal multiplier to amortise round-trips) until enough Runs are buffered, then withholds excess for subsequent calls.

The `limit` option on the lower-level `loadHistory` still counts completed messages (not Runs) and is the contract documented below:

```typescript
await view.loadOlder(10);
// view.runs() returns the visible RunInfo[] including up to 10
//   newly-revealed older Runs.
// view.getMessages() returns the concatenated flat TMessage list across
//   all visible Runs.
// view.hasOlder() - whether more history is available
// view.loadOlder(10) - load more older Runs
```

### Wire limit multiplier

`loadHistory` requests `limit * 10` Ably messages per page (`wireLimit`) to account for the many-to-one ratio between wire and domain messages. This is a heuristic; a single assistant message with streaming may produce dozens of Ably messages, so fetching only `limit` Ably messages would almost never yield `limit` complete messages.

The View applies its own multiplier (`_RUN_TO_MESSAGE_FETCH_FACTOR = 3`) on top of this when requesting pages for `loadOlder(limit)`. Because the View paginates by **Runs** but `loadHistory` paginates by **messages**, the factor amortises the typical messages-per-Run ratio (~2 for a user + assistant pair, with headroom for tool calls) so a single round-trip usually satisfies the Run-unit target before `_loadUntilVisible` has to fetch another page.

### Completed vs partial

The completion counter only counts messages whose terminal wire `status` — `complete` or `cancelled` — has been seen (an errored run ends via the `ai-run-end` lifecycle event, which carries no `codec-message-id` and so doesn't advance the counter). A run whose stream is still in progress, or spans a page boundary, doesn't advance the counter until a later page supplies its terminal signal, so the fetch loop keeps paging. The raw wires for a partial run are still returned - the View buffers and re-decodes them once the rest of the run arrives.

## Result shape

```typescript
/** A page of raw history wires from the channel. Internal to View/loadHistory. */
interface HistoryPage {
  rawMessages: Ably.InboundMessage[]; // Raw Ably messages, chronological (oldest first)
  hasNext(): boolean;
  next(): Promise<HistoryPage | undefined>;
}
```

`HistoryPage` (defined in `src/core/transport/types/view.ts`) carries only raw wires - there is no decoded `message`, header, or serial field, because `loadHistory` doesn't decode. `rawMessages` holds the Ably messages fetched since the previous page, reversed to chronological order (oldest first). The View re-decodes these into the [conversation tree](conversation-tree.md#apply-the-two-mutation-entry-points), reading [branching metadata](wire-protocol.md#branching-headers) and serials directly off each raw wire.

## Channel attach and untilAttach

`loadHistory()` [attaches the channel](glossary.md#channel-attach-ably) (idempotent) and uses [`untilAttach: true`](glossary.md#untilattach-ably) on the history call. This guarantees no gap between historical messages and the live subscription - the history ends exactly where the subscription starts.

## Shared state across pages

The `HistoryState` object persists across `next()` calls within a single history traversal:

- `rawMessages` - all Ably messages collected across all pages, in newest-first order (as received from Ably)
- `returnedCount` - how many completed messages have been served to the consumer so far
- `returnedRawCount` - how many raw Ably messages have been served so far (so each page's `rawMessages` slice covers only newly-fetched wires)
- `lastAblyPage` - cursor for Ably pagination
- `startedCodecMessageIds` / `terminatedCodecMessageIds` / `completedCodecMessageIds` - the [completion counter](#completion-counter)
- `logger` - logger for diagnostic output

Each `next()` call either serves a buffered page (when an earlier fetch already gathered more than `limit` completions) or fetches more Ably pages, which extends `rawMessages` and re-runs the header scan. The returned page's `rawMessages` are the wires fetched since the previous page (empty for a buffered page).

See [Decoder](decoder.md) for how the decoder processes Ably messages into domain events. See [Conversation tree](conversation-tree.md) for how the View applies decoded messages into the tree using headers and serials read off each raw wire. See [Codec interface](codec-interface.md#reducer-and-projection) for the reducer that folds decoder outputs into a per-Run projection.
