# Abstractions

## Layout

The generic layer lives in `src/core/`. Each provider lives in its own
directory (`src/vercel/`, `src/openai/`, …): its row table under a `codec/`
subdirectory, and beside it the adaptor and decoder factories that wrap that
codec. A provider directory may depend on the generic layer and on its own
provider SDK, never on another provider. It may also hold an adapter to its
provider's own client framework, in a subdirectory of its own
(`src/vercel/chat-transport/`, the `useChat` transport, is the instance). The
SDK's own identity, the errors,
the logger and the event emitter sit at the top of `src/` and `src/core/`.
Tests mirror `src/` under `test/`.

The package ships five entry points, each with its own `index.ts` (see the
table). That `index.ts` is the authoritative list of what is public: only
types and functions it re-exports are public API. A new codec adds a new entry
point rather than changing an existing one.

| Entry point                    | Purpose                                                                                                         | Peer deps                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `@ably/ai-transport`           | The agent adaptor, the decoder, the codec contract and the `defineCodec` builder                                | a Pub/Sub client                      |
| `@ably/ai-transport/vercel`    | An adaptor and a decoder over the Vercel AI SDK's `UIMessageChunk`s, and a `useChat` transport over the decoder | a Pub/Sub client, `ai`                |
| `@ably/ai-transport/openai`    | An adaptor and a decoder over OpenAI Responses stream events                                                    | a Pub/Sub client, `openai`            |
| `@ably/ai-transport/ag-ui`     | An adaptor and a decoder over AG-UI events                                                                      | a Pub/Sub client, `@ag-ui/core`       |
| `@ably/ai-transport/anthropic` | An adaptor and a decoder over Anthropic Messages stream events                                                  | a Pub/Sub client, `@anthropic-ai/sdk` |

Each row's Purpose is a summary, not a symbol list. The entry point's own
`index.ts` is the authoritative list.

The SDK is a library and declares no side of the connection, so it depends on
`@ably/pubsub-core`, the Pub/Sub API with no client in it, and works on a
channel of a client the application built with `@ably/pubsub-server` or
`@ably/pubsub-device` (_a Pub/Sub client_ in the table), both optional peers.
The core is a regular dependency rather than a peer because Ably tells
applications not to install it themselves: each per-side package depends on
it, and the SDKs layered on Pub/Sub do the same.

## Two-layer architecture

The codebase splits into a **generic layer** and a **codec layer**. The codec
layer is implemented once per provider, and each implementation is a _codec_
(Vercel, OpenAI, …). This separation is the most important invariant to
preserve.

- **Generic layer** (`src/core/`) defines the codec contract
  (`src/core/codec/codec.ts`), the `defineCodec` builder (`src/core/codec/`),
  the agent adaptor with its event writer, codec sink, pipe writer and
  message streams (`src/core/adaptor/`), and the decoder with its core
  (`src/core/decoder/`). It is framework-agnostic and
  knows nothing about any provider's wire types (Vercel's `UIMessageChunk`,
  OpenAI's `ResponseStreamEvent`). Of what a codec writes it reads only three
  things: the decoder filters on the message name and `extras.ai.codec`, which
  every codec writes as its own `name` and `id`, and the builder reads its own
  `type` to pick a row. The adaptor's pipe writer writes two fields of its own
  under `extras.ai`, `stream` and `ends`, which the decoder core reads and no
  codec does.

- **Codec layer** (`src/vercel/`, `src/openai/`, …) is one codec per provider,
  a row table built with `defineCodec` against that provider's own types, and
  the adaptor and decoder factories over it, and, where the provider's client
  framework needs one, an adapter to that framework (see Layout).

The application owns the channel. It gets an `Ably.RealtimeChannel` from
its Pub/Sub client, hands it to an adaptor on the agent side, and on the client side
subscribes to it with `channel.subscribe(decoder.receive)` and pages its
history through `decoder.decode`. No part of the SDK resolves a channel or
holds a client. The one part that attaches and detaches a channel is the
`useChat` transport, which the application hands its channel: `ChatTransport`
asks it at any moment which turn is running, so it reads history back to the
latest turn from where the channel attached, and keeps reading live. It
attaches the channel when nothing has, and `close()` detaches only a channel
its own read attached, so the next reader attaches it again and reads history
from there. A channel the application attached stays attached.

Codec, adaptor and decoder are distinct. The **codec** owns the wire format:
which Ably message an event becomes, whether that message is a publish, an
append or an update, which stream key it belongs to, and which keys it ends,
and the event each message decodes back to. It holds no state. The **agent
adaptor** owns writing: the per-writer key table, sending appends and repairing
a failed one. The **decoder** owns reading: the per-serial state the
platform's append model forces on a reader, and the filter that keeps other
messages away from the codec. One rule of the key table shapes every codec's
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
under a key is for a message a later `update` replaces. **Neither the adaptor
nor the decoder holds conversation state.**
Merging an event stream into messages is the application's job, through the
provider's own reducer, and no reducer or projection contract lives in
`src/core/`. That boundary is the most important one in the codebase: a
projection put back inside the decoder is the mistake this design exists to
prevent.

**The builder is one-to-one; the contract admits more.** A row's `encode`
maps an event to exactly one publish, append or update, or to nothing
(`undefined`), and its `decode` maps one delivery to exactly one event, or to
nothing (`undefined`) for a type the codec never publishes, and the built
codec wraps each into the zero- or one-element array the `Codec` contract
speaks. The contract itself is `encode(event): EncodedMessage[]` and
`decode(message): E[]`, so a hand-written codec can split a payload that is
too large for one message or fold one message into several events; the
adaptor writes an event's messages in order, and the decoder returns one
delivery per decoded event, with one `event: undefined` delivery for a message
that decodes to nothing. No shipped codec uses that room.
The places the wire departs from one-to-one are the platform's. A late joiner's
first delivery of a stream is a full-content update, which the decoder core
reduces to the tail the joiner has not seen; a repair after a failed append
rewrites the whole message, which a live subscriber reads the same way; and
the append rollup, where Ably delivers the appends a connection publishes
within a window (40ms by default) as one message with the data joined and the
last append's extras, so a subscriber can receive fewer deltas than the agent
wrote, each carrying more text. The window is the publishing client's
`appendRollupWindow` transport param, and 0 gives one delivery per append.
A message stream sends appends as they arrive, and the pipe writer waits only
before the message that ends a stream, so a closer is never rolled up with, or
delivered ahead of, the delta before it (`src/core/adaptor/pipe-writer.ts`).

**Wire curation belongs to the codec, at encode.** Every type in the codec's
event union has a row. A row that returns `undefined` keeps its event off the
wire on purpose; an event whose type has no row throws `InvalidArgument` at
encode, so a provider event nobody thought about fails loudly rather than
leaking onto the channel or vanishing. The row table's type makes a missing
row a compile error, so the throw is for a type the provider adds after the
codec was written.

## The adaptor and decoder surface

`createAgentAdaptor(channel, codec, { logger?, headers? })`, or a provider's
`vercelAdaptor(channel)` and its siblings, returns an adaptor with four
operations. One is the primitive for a stream of events, two are loops over
it, and `send` publishes one whole message and uses none. `newWriter` gives
out an event writer, the one thing that writes a stream of events: it owns the
key table from its first `write` to its `close`, `write` hands an event over
and returns at once, as the Pub/Sub message stream's `append` does, writes are
made in the order they were called, `flush` drains the writes already called
and flushes and repairs, keeping the writer and its streams open, and resolves
with the serial the last event landed on, and `close` does the same and
refuses later writes, writing no closer. Failures split as the Pub/Sub message
stream's do: an event that cannot be written throws at its own `write` and the
writer carries on, and a failure to get a write onto the channel stops the
writer, so a later `flush` or `close` rejects with it and a later `write`
throws it and `flush` resolving means nothing handed over was lost. `flush`
and `close` also resolve with a handoff, the streams left open as plain JSON
(each key and its message's serial), and `adoptWriter` gives out a writer that
carries them on in the same messages, as the Pub/Sub message stream's
`adoptStream` does: one stream stays on one serial, so its end event ends the
message a decoder remembers and the decoder forgets it. `abort` stops a
writer as the Pub/Sub message stream's `abort` does with no message: it waits
for no ack, repairs nothing and ends no stream, so a retry can adopt the last
handoff with nothing more from the old writer reaching the channel. A new writer given a
stream's later events without the handoff has no key table to append under,
so it opens a new message and the first stays open on every decoder. A stream
stays open in a writer until its closer is written
(`src/core/adaptor/event-writer.ts`). `pipeEach` gives an event writer
each event a stream or async iterable yields, reading the next only when the
loop asks for it, and flushes the writer on every exit, leaving the loop early
included. `pipe` is `pipeEach` run to its end, resolving with the serial of
its last publish; both reject with `OperationCancelled` when the signal fires
and `PipeFailed` when the pipe could not finish. `send` publishes one whole
message and resolves with the ack serial: it keeps no key table, so it refuses
an event that appends or updates, and it reports a publish failure under its
own codes. A new way to write a stream is a loop over an event writer, never a
second copy of the step that writes one event. The step returns a failure
rather than throwing it, so each caller reports it in its own terms and one
caller's error contract never moves another's: a pipe's `PipeFailed` and the
writer's own failure, the channel's error as it threw it, both come from the
same step. Like the Pub/Sub message stream, the writer passes a channel's
error through rather than wrapping it, so nothing has to tell the channel's
errors from the writer's own, which codes cannot do. See the module doc
comment on `src/core/adaptor/agent-adaptor.ts` for the current contract.

`createDecoder(codec)`, or a provider's `vercelDecoder()` and its siblings,
returns a decoder. `receive` is a bound arrow property for
`channel.subscribe(decoder.receive)`, and emits each delivery to the `onEvent`
handlers. `decode` returns a message's deliveries without emitting, for a
history loop. `onError` reports a codec that threw. Use one decoder per
codec per channel, for live and history together, so its version guard drops a message
of an open stream that both carry. A stream whose closer was decoded is forgotten,
so a later copy of it decodes again. History pages arrive newest first and the decoder takes them in
that order; the application orders what it renders.

A delivery is `{ event, message }`, and every message the decoder is given
comes back as at least one. `event` is `undefined` when the codec has nothing
for the message: a message without the codec's `name` and `id`, a
replay the version guard dropped, a `message.delete`, or a decode that threw.
The application always sees the raw message and decides for itself.

## Composition, not inheritance

The adaptor and the decoder are assembled from parts, not class hierarchies.
An event writer composes a sink, which turns each event into channel writes.
The codec sink composes the codec, the writer's headers and a pipe writer; a
pipe writer composes the key table from a codec's stream keys to message
streams, and stamps the markers a decoder reads; a message stream holds one
message's appends, its content and its repair. A pipe driver composes an event
writer and the source it reads into it. A decoder composes the decoder core,
the codec and one event emitter for deliveries and errors. There is no base
class anywhere. Each part is constructed and injected, and each layer wires
the layer below it.

The split follows what a part's state is scoped to. One message's pending
appends and content live in its message stream; the live keys of one event
writer, a pipe's included, live in its pipe writer; the event writer itself
holds only the order of its writes and whether it has stopped or closed, so an
adaptor holds none of its own and needs no `close`. State scoped to a
channel's reader (the decoder core's table of the streams in flight, opened by
the writer's `stream` marker and freed by its `ends` marker) lives in the
decoder. A codec holds no state, so one codec value serves every adaptor and
decoder that uses it.

The split also follows what outlives the codec. Streaming patches, which
mutate one message per response through the Pub/Sub SDK's message stream, are
to replace the codec. The codec, the codec sink, the pipe writer's key table
and markers, and the decoder core's stream tracking are the codec's wire
format and go with it; the message stream here stands in for the SDK's and
gives way to it; the event writer, the pipe drivers and the adaptor's surface
stay. So nothing that stays reads a codec's stream keys or markers: the event
writer reaches them only through its sink, and a sink of another kind takes
the codec sink's place.

## Dependency injection

All dependencies are passed through constructors or option objects. There are
no singletons or service locators. The one module-level registry is the
`useChat` transport's table of reader closes in flight, keyed by channel
(`src/vercel/chat-transport/turn-reader.ts`): a reader must not subscribe
until the previous reader on its channel has detached it, even one another
chat transport opened, and nothing else connects the two.
Platform globals the runtime provides, such as `fetch` and timers, are called
directly rather than injected, and a test replaces them with `vi.stubGlobal`
or fake timers.

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
  lifecycle (construct/dispose): the adaptor, the decoder and the parts they
  compose.
- **Plain function** for stateless transformations, one-shot utilities, and a
  codec row's encode and decode. Input in, output out, no retained state.

## Summary of principles

1. **Generic-vs-codec split.** The adaptor, the decoder and the builder know
   nothing about any specific provider; each codec (Vercel, OpenAI, …) is a
   row table over its provider's own types.
2. **Codec, adaptor and decoder separation.** The codec owns the wire format
   and holds no state; the adaptor owns writing and the per-writer key table;
   the decoder owns the per-serial reading state. The application owns the
   channel. None holds conversation state.
3. **The builder is one-to-one.** A row's encode and decode each map one to
   one, or to nothing; the codec contract speaks arrays so a hand-written
   codec can split or fold. The decoder core absorbs the platform's two
   departures from one-to-one.
4. **Constructor/option injection.** No singletons or service locators; the
   one module-level registry, and why it exists, is under Dependency injection.
5. **Composition, not inheritance.** Compose features; no class hierarchies.
6. **Interface-first.** Public contracts are interfaces; implementations are
   internal `Default*` classes, exposed via factory functions.
7. **The adaptor owns two wire fields, and the codec three, all under
   `extras.ai`, plus the message name.** A row speaks in `data`, `fields` and `headers`: a plain
   publish carries the event in `data`, and a message that is appended to
   carries the appended text in `data` and the event's other fields in
   `fields`, since an append grows `data` and carries nothing else. The
   builder writes `fields` under `extras.ai.fields`, nested objects and
   arrays as they are, beside its own `type` under `extras.ai`, the key the
   platform reserves for this SDK, and reads `extras.ai.type` back to pick
   the row. A codec gives every message it encodes its own `name` (`ai` by
   default) and writes its `id` as `extras.ai.codec`, appends included,
   since Ably keeps the last write's name and extras; a decoder reads both
   off the codec and skips any message that carries another. The builder
   does this for every row, and a hand-written codec must do it itself. The
   adaptor's pipe writer stamps `extras.ai.stream` on every
   write under a live key, so a stream's message carries it however it is
   read back, and `extras.ai.ends`, the serial it ends, on the message that
   ends one; the decoder core reads both to know which messages to remember
   and when to forget them (`src/core/wire.ts` holds the names). `headers`
   is Ably's `extras.headers`, the key its server-side filtering reads, and a
   row writes it only to expose a field there on purpose. Ably admits only a
   flat map of string, number, boolean and null values under it (error 40032
   otherwise), so the row property is typed to that and written as given; the
   builder translates and checks nothing. The adaptor adds its default
   headers and the headers of the call that publishes, or of the event
   writer it opened, those over the defaults, and prefers the row's over both
   where they name a key, so a
   row keeps a header it writes and its `decode` sees the merged map
   (`src/core/adaptor/headers.ts`), since the wire cannot tell a caller's
   headers from the row's; the shipped codecs rebuild events from `fields` and
   never spread `headers`. A `type`
   key in `fields` travels like any other, and the type the builder matched
   reaches a row's `decode` as `type` on the body. A row never touches
   `extras`. A message without the codec's `name` and `id` is **foreign**: the application shares the channel, so the decoder delivers
   it raw with no event and never hands it to the codec or its core.
8. **Explicit exports.** Only what an `index.ts` re-exports is public API.
9. **Self-contained features.** Each manages its own subscriptions, state, and
   cleanup.
10. **The application owns the channel.** The SDK never resolves or
    configures a channel and never holds a client. An adaptor takes a channel
    to write to and a decoder takes messages, so the application chooses the
    channel's options and lifecycle with its Pub/Sub client and can use the
    same channel for its own messages. The `useChat` transport is the one part
    that attaches and detaches the channel it is handed, and why is under
    Two-layer architecture. Nothing writes Ably-Agent attribution, since that
    needs the client.
11. **No message assembly anywhere in the package.** No reducer, no merge
    driver and no projection type. A delivery carries one event, and the
    application groups deliveries by `message.serial`, by the ids the
    provider's own events carry, or by a header the publishing call
    attached, then folds them with the provider's reducer.
    `demo/minimal/src/app/chat.tsx` is the worked example. The one place the
    package groups deliveries is the `useChat` transport, because
    `ChatTransport` hands `useChat` one stream per turn: it cuts the
    deliveries at each turn's `start` and terminal chunk, and keeps the
    latest turn's chunks so a later `reconnectToStream` can replay them. It
    still builds no messages; `useChat`'s own reducer does.
