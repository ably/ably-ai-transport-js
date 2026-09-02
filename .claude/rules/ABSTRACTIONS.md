# Abstractions

## Layout

The generic layer lives in `src/core/` and `src/react/`; each codec lives in its own directory
(`src/vercel/`, `src/openai/`, …) under a `codec/` subdirectory. A codec entry
point may also ship provider-shaped helpers outside `codec/` — modules that
map a provider result onto transport types or derive loop state from provider
items rather than defining wire format. Such a helper may depend on the
generic layer and on its own provider SDK, never on another codec. Shared
header/event/message-name constants, Ably message helpers, and the SDK's own
identity sit at the top of `src/`. Tests mirror `src/` under `test/`.

The package ships four entry points, each with its own `index.ts` (see the
table). That `index.ts` is the authoritative list of what is public — only
types and functions it re-exports are public API. A new codec adds a new entry
point rather than changing an existing one.

| Entry point                 | Purpose                                            | Peer deps        |
| --------------------------- | -------------------------------------------------- | ---------------- |
| `@ably/ai-transport`        | Core, codec-agnostic transport and codec contracts | `ably`           |
| `@ably/ai-transport/react`  | Generic React hooks and providers for any codec    | `ably`, `react`  |
| `@ably/ai-transport/vercel` | Vercel AI SDK wire codec                           | `ably`, `ai`     |
| `@ably/ai-transport/openai` | OpenAI Responses wire codec                        | `ably`, `openai` |

Each row's Purpose is a summary, not a symbol list — the entry point's own
`index.ts` is the authoritative surface.

## Two-layer architecture

The codebase splits into two layers: a **generic layer** and a **codec layer**.
The codec layer is implemented once per provider — each such implementation a
_codec_ (Vercel, OpenAI, …). This separation is the most important invariant to
preserve:

- **Generic layer** (`src/core/`, `src/react/`) — defines the codec contract
  (see `src/core/codec/types.ts` for its current signature) and the
  codec-parameterized transports in `src/core/transport/`. Both halves must
  know nothing about any specific codec's wire types (e.g. Vercel's
  `UIMessageChunk` / `UIMessage`, OpenAI's `ResponseStreamEvent`), and must
  read or write only transport-tier metadata — never codec-specific domain
  metadata (see header discipline below).

  The two halves differ in what else they may depend on. `src/core/` is
  framework-agnostic. `src/react/` is codec-agnostic but React-only: it may
  reach for `react`, `ably` and `ably/react`, and it carries the transport's
  event types erased, re-applying the caller's type arguments at the hook
  boundary — which is what keeps it free of any codec.

- **Codec layer** (`src/vercel/`, `src/openai/`, …) — one _codec_ per provider,
  each implementing the codec contract for that provider's wire format against
  its types.

Codec and transport are themselves distinct: the **codec** owns the wire format
(encode/decode of events and messages); the **transport** owns runs, steps,
channel I/O and history paging. **The transport holds no conversation state.**
Merging an event stream into messages is the application's job — or the
provider reducer's — and no reducer or projection contract lives in
`src/core/`. That boundary is the most important one in the codebase: a
projection put back inside the transport is the mistake this design exists to
prevent. The transport is parameterized by the codec and never hardcodes a wire
format.

**Wire curation belongs to the codec, at encode.** Every event a codec
supports is transmitted (as a discrete event or a stream, possibly with a
slimmed payload) or deliberately kept off the wire (a `drop` descriptor);
anything else throws at the encoder, so a genuinely unexpected provider event
fails loudly rather than leaking onto the channel. Agents pipe their output
stream to the transport as-is for everything the codec supports — an agent
that opts into a provider surface the codec doesn't model must filter those
events out before publishing, and the throw makes forgetting that loud. (A
provider SDK may still supply its own conversion first — Vercel's
`toUIMessageStream()` turns a `streamText` result into the chunk stream that
the codec's union models — but that is the provider's shape conversion, not
our curation point.)

## Transport surface

The receive side has one classifier and the send sides are split by role:

- **ReceiveTransport** — the single place an inbound Ably message becomes a
  typed `TransportEvent`: a run-lifecycle event, a step-lifecycle event, or a
  codec-decoded message carrying the decoded inputs and outputs. It classifies
  by the `extras.ai` envelope, never by the wire `name`. A message with no
  envelope is foreign: it decodes to no events and drives no run, while still
  surfacing raw on `ably-message`.
- **ClientTransport** — publish input, cancel, steer, subscribe to the
  classified event stream, and page history backwards from the attach point.
  Publishing emits nothing locally: the sender's own input comes back as the
  ordinary channel delivery, keyed by the returned `transportMessageId`, so a
  consumer that wants optimistic UI renders its own and reconciles on that id.
  A steer's `published` resolves from the publish acknowledgement's serial, not
  from the steer's own echo, so steering works with `echoMessages: false`.
- **AgentTransport** — open runs, locate the input that woke an invocation,
  publish output through a run's pipe or steps, and route inbound cancel and
  steer onto the matching run handle.

None of the three holds conversation state. A consumer that wants a message
list merges the event stream itself, or hands it to the provider's own reducer.
See `src/core/transport/index.ts` and the module doc comments on
`client-transport.ts`, `agent-transport.ts` and `receive-transport.ts` for the
current surface.

## Composition, not inheritance

Transports are assembled from composable parts, not class hierarchies.
`createAgentTransport` is the worked example: it composes the run-manager
lifecycle publisher, the step and pipe writer, a codec decoder wrapped in a
receive transport, and the steer tracker. There is no base class anywhere in
the chain — each part is constructed and injected, and the transport wires
them together.

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
  component is only ever composed by a factory in the same layer — nothing
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

- **Class** — when a component holds state, manages subscriptions, or has a
  lifecycle (construct/dispose). Most transport sub-components.
- **Plain function** — stateless transformations, one-shot utilities, codec
  encode/decode. Input in, output out, no retained state.

## Summary of principles

1. **Generic-vs-codec split** — the generic transport/codec knows nothing about
   any specific codec; each codec (Vercel, OpenAI, …) implements the codec
   contract for its provider's wire format.
2. **Codec/transport separation** — codec owns the wire format; transport owns
   runs, steps, channel I/O and history paging, parameterized by the codec. It
   holds no conversation state.
3. **Codec-parameterized** — generic components are parameterized by the
   codec's input and output unions; see `src/core/codec/types.ts` for the
   current signature.
4. **Constructor/option injection** — no singletons, no globals.
5. **Composition, not inheritance** — compose features; no class hierarchies.
6. **Interface-first** — public contracts are interfaces; implementations are
   internal `Default*` classes, exposed via factory functions.
7. **Header discipline** — SDK metadata travels on the wire under an
   `extras.ai` envelope split into a transport tier (`extras.ai.transport`,
   always present) and an optional codec tier (`extras.ai.codec`). The generic
   layer reads and writes only the transport tier; codec-specific metadata
   belongs in the codec tier, owned by the codec layer. The envelope is also
   what marks a wire as ours: a transport shares its channel with the
   application, so a message without `extras.ai` is **foreign** — it decodes
   to no events and drives no run, while still surfacing raw on
   `ably-message`. Classify foreign traffic by the envelope, never by the wire
   `name`, which the platform does not echo on appends.
8. **Explicit exports** — only what an `index.ts` re-exports is public API.
9. **Self-contained features** — each manages its own subscriptions, state, and
   cleanup.
10. **Single shared channel, caller-owned** — one Ably channel per transport,
    shared by all features. The caller resolves and owns the channel; the
    transport subscribes its own listener and never detaches it. Two
    obligations come with that: the caller stamps `channelAgent(codec)` as the
    channel's `params.agent`, because the SDK cannot set it once the caller
    owns resolution, and every resolver of the same channel funnels its modes
    through `resolveChannelModes()` so they all request the same modes in the
    same order — ably-js compares them order-sensitively, so two resolvers that
    disagree reattach the channel or silently revert its mode set. See
    `src/core/channel-options.ts`.
11. **No message assembly in the SDK** — no reducer, no merge driver, no
    projection type. The application demultiplexes a batch's `message` events
    by their transport-message-id and merges each bucket with the provider's own
    machinery.
