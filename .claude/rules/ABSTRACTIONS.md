# Abstractions

## Layout

The generic layer lives in `src/core/` and `src/react/`. Each codec lives in
its own directory (`src/vercel/`, `src/openai/`, …) with its row table under a
`codec/` subdirectory. A codec directory may depend on the generic layer and on
its own provider SDK, never on another codec. The SDK's own identity, the
channel option helpers, the errors, the logger and the event emitter sit at the
top of `src/` and `src/core/`. Tests mirror `src/` under `test/`.

The package ships four entry points, each with its own `index.ts` (see the
table). That `index.ts` is the authoritative list of what is public: only
types and functions it re-exports are public API. A new codec adds a new entry
point rather than changing an existing one. Anthropic and AG-UI codecs are
planned as further entry points.

| Entry point                 | Purpose                                                         | Peer deps        |
| --------------------------- | --------------------------------------------------------------- | ---------------- |
| `@ably/ai-transport`        | The transport, the codec contract and the `defineCodec` builder | `ably`           |
| `@ably/ai-transport/react`  | A provider and hooks over the transport, for any codec          | `ably`, `react`  |
| `@ably/ai-transport/vercel` | The Vercel AI SDK codec: one row per `UIMessageChunk` type      | `ably`, `ai`     |
| `@ably/ai-transport/openai` | The OpenAI Responses codec: one row per stream event type       | `ably`, `openai` |

Each row's Purpose is a summary, not a symbol list. The entry point's own
`index.ts` is the authoritative list.

## Two-layer architecture

The codebase splits into a **generic layer** and a **codec layer**. The codec
layer is implemented once per provider, and each implementation is a _codec_
(Vercel, OpenAI, …). This separation is the most important invariant to
preserve.

- **Generic layer** (`src/core/`, `src/react/`) defines the codec contract
  (`src/core/codec/codec.ts`), the `defineCodec` builder with its decoder core
  (`src/core/codec/`), and the transport (`src/core/transport/`). It knows
  nothing about any provider's wire types (Vercel's `UIMessageChunk`, OpenAI's
  `ResponseStreamEvent`) and reads nothing a codec writes: the builder's own
  `type` field is the one thing it looks at, and only to pick a row. The
  transport writes two fields of its own under `extras.ai`, which the decoder
  core reads and no codec does.

  The two halves differ in what else they may depend on. `src/core/` is
  framework-agnostic. `src/react/` is codec-agnostic and React-only: it may
  reach for `react`, `ably` and `ably/react`, and it stores the transport with
  its event type erased, re-applying the caller's type argument at the hook
  boundary, which is what keeps it free of any codec.

- **Codec layer** (`src/vercel/`, `src/openai/`, …) is one codec per provider,
  a row table built with `defineCodec` against that provider's own types.

Codec and transport are themselves distinct. The **codec** owns the wire
format: which Ably message an event becomes, whether that message is a
publish, an append or an update, which stream key it belongs to, and which keys
it ends. The **transport** owns channel I/O: the per-pipe key table, sending
appends and repairing a failed one, subscribing, history paging and
continuity. One rule of the key table shapes every codec's
streams: **an append to a key that is not live publishes the message and opens
the key**, so a stream's deltas share a message that its first delta creates,
and the event that opens the stream and the one that ends it are plain
publishes of their own. Ably's append replaces the stored `name` and `extras`
with the append's, so a message opened by a start event and grown by deltas
would read back from history under the last delta's type, with the text on a
message the start event's row cannot decode. With the deltas alone sharing a
message, history and a late joiner decode the sequence the agent produced, the
one permitted collapse being consecutive deltas arriving as fewer, larger ones.
No codec row puts `publish:` on an opener or `append:` on a closer; `publish:`
under a key is for a message a later `update` replaces. **The transport holds
no conversation state.**
Merging an event stream into messages is the application's job, through the
provider's own reducer, and no reducer or projection contract lives in
`src/core/`. That boundary is the most important one in the codebase: a
projection put back inside the transport is the mistake this design exists to
prevent.

**The builder is one-to-one; the contract admits more.** A row's `encode`
maps an event to exactly one publish, append or update, or to nothing
(`undefined`), and its `decode` maps one delivery to exactly one event, and
the built codec wraps each into the zero- or one-element array the `Codec`
contract speaks. The contract itself is `encode(event): EncodedMessage[]` and
`decode(message): E[]`, so a hand-written codec can split a payload that is
too large for one message or fold one message into several events; the
transport writes an event's messages in order and delivers one delivery per
decoded event, with one `event: undefined` delivery for a message that decodes
to nothing. Neither shipped codec uses that room.
The places the wire departs from one-to-one are the platform's. A late joiner's
first delivery of a stream is a full-content update, which the decoder core
reduces to the tail the joiner has not seen; a repair after a failed append
rewrites the whole message, which a live subscriber reads the same way; and
the append rollup, where Ably delivers the appends a connection publishes
within a window (40ms by default) as one message with the data joined and the
last append's extras, so a subscriber can receive fewer deltas than the agent
wrote, each carrying more text. The window is the publishing client's
`appendRollupWindow` transport param, and 0 gives one delivery per append.
The pipe writer sends appends as they arrive and waits only before the
message that ends a stream, so a closer is never rolled up with, or delivered
ahead of, the delta before it (`src/core/transport/pipe-writer.ts`).

**Wire curation belongs to the codec, at encode.** Every type in the codec's
event union has a row. A row that returns `undefined` keeps its event off the
wire on purpose; an event whose type has no row throws `InvalidArgument` at
encode, so a provider event nobody thought about fails loudly rather than
leaking onto the channel or vanishing. The row table's type makes a missing
row a compile error, so the throw is for a type the provider adds after the
codec was written.

## The transport surface

`createTransport({ channel, codec, logger? })` returns one object with six
operations. `send` encodes one event and publishes it as a one-off message,
resolving with the ack serial. `pipe` reads a stream or async iterable, writes
each event as its row directs, and resolves with the serial of its last publish
once the source has ended; it rejects with `OperationCancelled` when its signal
fires and `PipeFailed` when it could not finish, having flushed and repaired
what it wrote either way. `subscribe` delivers every message on the channel to
a handler, attaching the channel on the first call, and returns the
unsubscribe. `history` opens a walk backwards from the attach point through
the same codec and returns its newest page, whose `next()` leads to the older
ones; after a discontinuity an application pages it back to the last serial it
applied. `on` reports a discontinuity (with no payload) or an error with no
caller to reject, and `close` aborts the pipes in flight and releases the
channel listener. See the module doc comment on
`src/core/transport/transport.ts` for the current contract.

A delivery is `{ event, message }`, and every message is delivered. `event` is
`undefined` when the codec has nothing for the message: a foreign publish on
the shared channel, a replay the codec's version guard dropped, a
`message.delete`, or a decode that threw. The application always sees the raw
message and decides for itself. Publishing emits nothing locally: the sender's
own message comes back as the ordinary channel delivery, so a consumer that
wants optimistic UI renders its own and reconciles on the serial `send`
returned.

## Composition, not inheritance

The transport is assembled from parts, not class hierarchies. `createTransport`
composes a pipe writer per pipe (the key table, the append chain and the
repair), the pipe driver that reads a source through the codec into that
writer, the history pager over `loadHistoryPages`, the continuity watcher, and
one event emitter for deliveries, discontinuities and errors. There is no base class anywhere in the chain. Each part is constructed
and injected, and each layer wires the layer below it.

The split follows what a part's state is scoped to. State scoped to one pipe
(the live keys, the pending appends) lives in that pipe's writer. State scoped
to the transport (the subscriptions, the pipes in flight, whether the channel
listener is registered) lives in the transport. State scoped to the codec (the
decoder core's table of the streams in flight, opened by the writer's `stream`
marker and freed by its `ends` marker) lives inside the built codec, which is
why a codec instance is shared only when its transports may share a table.

## Dependency injection

All dependencies are passed through constructors or option objects. There are
no singletons or service locators.

## Class pattern

The shape a component takes is a choice with a reason, not a single mandate:

- **Interface + `Default*` class** where a consumer holds the thing: define a
  public **interface** for the contract (`Foo`) and implement it with a
  **`Default*` class** (`DefaultFoo`). The interface is public API; the class
  is internal.
- **Plain internal class or factory-composed object literal** where the
  component is only ever composed by a factory in the same layer. Nothing
  outside names the type, so an interface would be ceremony.

### Private state

Use `private readonly` fields with an underscore prefix. Store all
constructor-injected dependencies as private fields:

```ts
class DefaultFoo<TEvent, TMessage> implements Foo<TMessage> {
  private readonly _dep: SomeDependency<TMessage>;
  private readonly _logger: Logger;

  constructor(options: FooOptions<TEvent, TMessage>) {
    this._dep = options.dep;
    this._logger = options.logger.withContext({ component: 'Foo' });
  }
}
```

### Property access

Expose public state via getters that return the interface type, not the
implementation.

### Factory functions as entry points

Public entry points (`createFoo()`) are factory functions that instantiate and
wire up the internal classes. Consumers never call `new Default*` directly.

### Classes vs plain functions

- **Class** when a component holds state, manages subscriptions, or has a
  lifecycle (construct/dispose). Most transport sub-components.
- **Plain function** for stateless transformations, one-shot utilities, and a
  codec row's encode and decode. Input in, output out, no retained state.

## Summary of principles

1. **Generic-vs-codec split.** The transport and the builder know nothing about
   any specific codec; each codec (Vercel, OpenAI, …) is a row table over its
   provider's own types.
2. **Codec/transport separation.** The codec owns the wire format; the
   transport owns channel I/O, the per-pipe key table, history paging and
   continuity, parameterized by the codec. It holds no conversation state.
3. **The builder is one-to-one.** A row's encode and decode each map one to
   one, or to nothing; the codec contract speaks arrays so a hand-written
   codec can split or fold. The decoder core absorbs the platform's two
   departures from one-to-one.
4. **Constructor/option injection.** No singletons, no globals.
5. **Composition, not inheritance.** Compose features; no class hierarchies.
6. **Interface-first.** Public contracts are interfaces; implementations are
   internal `Default*` classes, exposed via factory functions.
7. **The SDK owns two wire fields, and the builder two more, all under
   `extras.ai`.** A row speaks in `headers`, and where they sit on the wire is
   the builder's choice: it writes them under `extras.headers`, the extras key
   Ably provides for a publisher's own fields, and its own `type` and `json`
   under `extras.ai`, the key the platform reserves for this SDK, and reads
   `extras.ai.type` back to pick the row. The transport's pipe writer stamps
   `extras.ai.stream` on every write under a live key, so a stream's message
   carries it however it is read back, and `extras.ai.ends`, the serial it
   ends, on the message that ends one; the decoder core reads both to know
   which messages to remember and when to forget them (`src/core/wire.ts`
   holds the names). Ably admits
   only a flat map of string, number, boolean and null values under
   `extras.headers` (error 40032 otherwise), and a provider's events carry
   nested objects and arrays, so the builder writes a nested value as JSON
   text and lists its key under `extras.ai.json` to parse it back on decode.
   `extras.headers` is the row's in both directions and the builder never
   reads or writes a key in it: a `type` header travels like any other, and
   the type the builder matched reaches a row's `decode` as `type` on the
   body. A row never touches `extras`. A message
   without `extras.ai.type` is **foreign**: the transport shares its channel
   with the application, so `decode` returns `undefined` and the transport
   delivers it raw. Classify by that field, never by the wire `name`, which is
   the codec author's to choose and a foreign publisher's to collide with.
8. **Explicit exports.** Only what an `index.ts` re-exports is public API.
9. **Self-contained features.** Each manages its own subscriptions, state, and
   cleanup.
10. **Single shared channel, caller-owned.** One Ably channel per transport,
    shared by all features. The caller resolves and owns the channel; the
    transport subscribes its own listener and never detaches it. Two
    obligations come with that: the caller stamps `channelAgent(codec)` as the
    channel's `params.agent`, because the SDK cannot set it once the caller
    owns resolution, and every resolver of the same channel funnels its modes
    through `resolveChannelModes()` so they all request the same modes in the
    same order. ably-js compares them order-sensitively, so two resolvers that
    disagree reattach the channel or silently revert its mode set. See
    `src/core/channel-options.ts`.
11. **No message assembly anywhere in the package.** No reducer, no merge
    driver, no projection type, and no grouping: a delivery carries one
    event, and the application groups deliveries by `message.serial` or
    by the ids the provider's own events carry, then folds them with the
    provider's reducer. `demo/minimal/src/app/chat.tsx` is the worked example.
