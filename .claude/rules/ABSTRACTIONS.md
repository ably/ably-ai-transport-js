# Abstractions

## Layout

The generic layer lives in `src/core/`. Each provider lives in its own
directory (`src/vercel/`, `src/openai/`, …): its row table under a `codec/`
subdirectory, and beside it the adaptor and decoder factories that wrap that
codec. A provider directory may depend on the generic layer and on its own
provider SDK, never on another provider. The SDK's own identity, the errors,
the logger and the event emitter sit at the top of `src/` and `src/core/`.
Tests mirror `src/` under `test/`.

The package ships four entry points, each with its own `index.ts` (see the
table). That `index.ts` is the authoritative list of what is public: only
types and functions it re-exports are public API. A new codec adds a new entry
point rather than changing an existing one. An Anthropic codec is planned as
a further entry point.

| Entry point                 | Purpose                                                                          | Peer deps             |
| --------------------------- | -------------------------------------------------------------------------------- | --------------------- |
| `@ably/ai-transport`        | The agent adaptor, the decoder, the codec contract and the `defineCodec` builder | `ably`                |
| `@ably/ai-transport/vercel` | An adaptor and a decoder over the Vercel AI SDK's `UIMessageChunk`s              | `ably`, `ai`          |
| `@ably/ai-transport/openai` | An adaptor and a decoder over OpenAI Responses stream events                     | `ably`, `openai`      |
| `@ably/ai-transport/ag-ui`  | An adaptor and a decoder over AG-UI events                                       | `ably`, `@ag-ui/core` |

Each row's Purpose is a summary, not a symbol list. The entry point's own
`index.ts` is the authoritative list.

## Two-layer architecture

The codebase splits into a **generic layer** and a **codec layer**. The codec
layer is implemented once per provider, and each implementation is a _codec_
(Vercel, OpenAI, …). This separation is the most important invariant to
preserve.

- **Generic layer** (`src/core/`) defines the codec contract
  (`src/core/codec/codec.ts`), the `defineCodec` builder (`src/core/codec/`),
  the agent adaptor with its pipe writer (`src/core/adaptor/`), and the
  decoder with its core (`src/core/decoder/`). It is framework-agnostic and
  knows nothing about any provider's wire types (Vercel's `UIMessageChunk`,
  OpenAI's `ResponseStreamEvent`). Of what a codec writes it reads only three
  things: the decoder filters on the message name and `extras.ai.codec`, which
  every codec writes as its own `name` and `id`, and the builder reads its own
  `type` to pick a row. The adaptor's pipe writer writes two fields of its own
  under `extras.ai`, `stream` and `ends`, which the decoder core reads and no
  codec does.

- **Codec layer** (`src/vercel/`, `src/openai/`, …) is one codec per provider,
  a row table built with `defineCodec` against that provider's own types, and
  the adaptor and decoder factories over it.

The application owns the channel. It gets an `Ably.RealtimeChannel` from
ably-js, hands it to an adaptor on the agent side, and on the client side
subscribes to it with `channel.subscribe(decoder.receive)` and pages its
history through `decoder.decode`. No part of the SDK resolves, attaches or
detaches a channel, and none holds a client.

Codec, adaptor and decoder are distinct. The **codec** owns the wire format:
which Ably message an event becomes, whether that message is a publish, an
append or an update, which stream key it belongs to, and which keys it ends,
and the event each message decodes back to. It holds no state. The **agent
adaptor** owns writing: the per-pipe key table, sending appends and repairing
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
The pipe writer sends appends as they arrive and waits only before the
message that ends a stream, so a closer is never rolled up with, or delivered
ahead of, the delta before it (`src/core/adaptor/pipe-writer.ts`).

**Wire curation belongs to the codec, at encode.** Every type in the codec's
event union has a row. A row that returns `undefined` keeps its event off the
wire on purpose; an event whose type has no row throws `InvalidArgument` at
encode, so a provider event nobody thought about fails loudly rather than
leaking onto the channel or vanishing. The row table's type makes a missing
row a compile error, so the throw is for a type the provider adds after the
codec was written.

## The adaptor and decoder surface

`createAgentAdaptor(channel, codec, { logger?, headers? })`, or a provider's
`vercelAdaptor(channel)` and its siblings, returns an adaptor with three
operations. `send` encodes one event and publishes it, resolving with the ack
serial. `pipe` reads a stream or async iterable unattended, writes each event
as its row directs, and resolves with the serial of its last publish; it
rejects with `OperationCancelled` when its signal fires and `PipeFailed` when
it could not finish, having flushed and repaired what it wrote either way.
`pipeEach` writes the same source and hands each event back with the serial it
landed on, reading the next event only when the loop asks for it; leaving the
loop early stops where it is, with no flush, no repair and no closer. See the
module doc comment on `src/core/adaptor/agent-adaptor.ts` for the current
contract.

`createDecoder(codec)`, or a provider's `vercelDecoder()` and its siblings,
returns a decoder. `receive` is a bound arrow property for
`channel.subscribe(decoder.receive)`, and emits each delivery to the `onEvent`
handlers. `decode` returns a message's deliveries without emitting, for a
history loop. `onError` reports a codec that threw. Use one decoder per
codec per channel, for live and history together, so its version guard drops a message
both carry. History pages arrive newest first and the decoder takes them in
that order; the application orders what it renders.

A delivery is `{ event, message }`, and every message the decoder is given
comes back as at least one. `event` is `undefined` when the codec has nothing
for the message: a message without the codec's `name` and `id`, a
replay the version guard dropped, a `message.delete`, or a decode that threw.
The application always sees the raw message and decides for itself.

## Composition, not inheritance

The adaptor and the decoder are assembled from parts, not class
hierarchies. An adaptor composes a pipe writer per pipe call (the key table,
the append chain and the repair) and the pipe driver that reads a source
through the codec into that writer. A decoder composes the decoder core, the
codec and one event emitter for deliveries and errors. There is no base class
anywhere. Each part is constructed and injected, and each layer wires the
layer below it.

The split follows what a part's state is scoped to. State scoped to one pipe
(the live keys, the pending appends) lives in that pipe's writer, so an
adaptor holds none of its own and needs no `close`. State scoped to a channel's
reader (the decoder core's table of the streams in flight, opened by the
writer's `stream` marker and freed by its `ends` marker) lives in the decoder.
A codec holds no state, so one codec value serves every adaptor and decoder
that uses it.

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
  lifecycle (construct/dispose): the adaptor, the decoder and the parts they
  compose.
- **Plain function** for stateless transformations, one-shot utilities, and a
  codec row's encode and decode. Input in, output out, no retained state.

## Summary of principles

1. **Generic-vs-codec split.** The adaptor, the decoder and the builder know
   nothing about any specific provider; each codec (Vercel, OpenAI, …) is a
   row table over its provider's own types.
2. **Codec, adaptor and decoder separation.** The codec owns the wire format
   and holds no state; the adaptor owns writing and the per-pipe key table;
   the decoder owns the per-serial reading state. The application owns the
   channel. None holds conversation state.
3. **The builder is one-to-one.** A row's encode and decode each map one to
   one, or to nothing; the codec contract speaks arrays so a hand-written
   codec can split or fold. The decoder core absorbs the platform's two
   departures from one-to-one.
4. **Constructor/option injection.** No singletons, no globals.
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
   headers and the headers of the `send` or `pipe` call, the call's over the
   defaults, and prefers the row's over both where they name a key, so a
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
10. **The application owns the channel.** The SDK never resolves, attaches,
    detaches or configures a channel and never holds a client. An adaptor
    takes a channel to write to and a decoder takes messages, so the
    application chooses the channel's options and lifecycle with ably-js and
    can use the same channel for its own messages. Nothing writes Ably-Agent
    attribution, since that needs the client.
11. **No message assembly anywhere in the package.** No reducer, no merge
    driver, no projection type, and no grouping: a delivery carries one
    event, and the application groups deliveries by `message.serial`, by
    the ids the provider's own events carry, or by a header the publishing
    call attached, then folds them with the provider's reducer.
    `demo/minimal/src/app/chat.tsx` is the worked example.
