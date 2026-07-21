# Abstractions

## Layout

The generic layer lives in `src/core/` and `src/react/`; each codec lives in its
own directory (`src/vercel/`, `src/openai/`, …), with any React hooks under a
`react/` subdirectory (e.g. `src/vercel/react/`). Within each, `codec/` and
`transport/` are separate concerns. Shared header/event/message-name constants
and Ably message helpers sit at the top of `src/` (`constants.ts`, `utils.ts`).
Tests mirror `src/` under `test/`.

The package ships several entry points, each with its own `index.ts` (see the
table). That `index.ts` is the authoritative list of what is public — only
types and functions it re-exports are public API. New codecs add a new entry
point — plus a `/react` one if they ship React hooks — rather than changing an
existing one.

| Entry point                       | Purpose                                                                                                          | Peer deps             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| `@ably/ai-transport`              | Core, codec-agnostic transport and codec interfaces (`createClientSession`, `createAgentSession`, `defineCodec`) | `ably`                |
| `@ably/ai-transport/react`        | Generic React hooks and providers for any codec                                                                  | `ably`, `react`       |
| `@ably/ai-transport/vercel`       | Vercel AI SDK codec, convenience factories, and the chat-transport adapter                                       | `ably`, `ai`          |
| `@ably/ai-transport/vercel/react` | React hooks for Vercel's `useChat`                                                                               | `ably`, `ai`, `react` |
| `@ably/ai-transport/openai`       | OpenAI Responses codec (`ResponsesCodec`)                                                                        | `ably`, `openai`      |

## Two-layer architecture

The codebase splits into two layers: a **generic layer** and a **codec layer**.
The codec layer is implemented once per provider — each such implementation a
_codec_ (Vercel, OpenAI, …). This separation is the most important invariant to
preserve:

- **Generic layer** (`src/core/`, `src/react/`) — defines the
  `Codec<TInput, TOutput, TProjection, TMessage>` interface (see
  `src/core/codec/types.ts`) and the codec-parameterized transport
  (`ClientSession`, `AgentSession`, `Tree`, View pagination). It is
  framework-agnostic: it must know nothing about any specific codec's wire
  types (e.g. Vercel's `UIMessageChunk` / `UIMessage`, OpenAI's
  `ResponseStreamEvent`), and must read or write only transport-tier metadata —
  never codec-specific domain metadata (see header discipline below).
- **Codec layer** (`src/vercel/`, `src/openai/`, …) — one _codec_ per provider,
  each implementing the `Codec` for that provider's wire format against its
  types, and optionally adding convenience factories and React hooks. Vercel is
  the fullest worked example: its chat-transport adapter wraps a generic
  `ClientSession` to satisfy the interface `useChat` expects.

Codec and transport are themselves distinct: the **codec** owns the wire
format (encode/decode of events and messages); the **transport** owns sessions,
runs, channel I/O, and conversation state. The transport is parameterized by
the codec and never hardcodes a wire format.

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

## Tree / View / Session split

The client side separates three concerns, with the Tree as the single source
of truth:

- **Tree** — complete conversation state (every node, from live messages and
  history) and active-run tracking. Emits unfiltered events for every change.
- **View** — a read-only pagination projection over the Tree (`View<TMessage>`):
  which history-loaded nodes are visible, re-emitting the Tree's events scoped
  to the visible window. The branch a View walks is supplied by an injected
  **BranchSource** strategy, so one projection serves both sides — the client's
  whole-tree branch navigation and the agent's leaf-pinned read. The client's
  `session.view` extends the base as `ClientView` (branch navigation + the write
  path). See `src/core/transport/types/view.ts` and `branch-source.ts`.
- **Session** — channel subscription, decode loop, and the send delegate behind
  the View's write path (plus `cancel`). Wires the channel into the Tree and
  exposes both as `session.tree` and `session.view`. Surfaces only an `error`
  event; all data events live on the Tree and View.

## Composition, not inheritance

Sessions are assembled from composable parts, not class hierarchies. A
`ClientSession` composes the codec, the Tree (state) and View (projection), and
the channel subscription + decode loop. An `AgentSession` composes the codec's
encoder with per-run stream piping and run tracking for cancel routing.

The same applies one level down: a View composes an injected **BranchSource**
strategy (visible-node resolution, message flattening, sibling navigation)
rather than specialising via subclasses, so the one View implementation serves
the client's navigable whole-tree branch and the agent's leaf-pinned branch
alike. The read base is `View<TMessage>`; the client's writable/navigable
surface is `ClientView extends View`.

## Dependency injection

All dependencies are passed through constructors or option objects. There are
no singletons or service locators.

## Class pattern

Use ES6 classes with the **interface + default implementation** pattern:

- Define a public **interface** for the contract (e.g. `ClientSession`, `Tree`,
  `View`).
- Implement it with a **`Default*` class** (e.g. `DefaultClientSession`,
  `DefaultTree`, `DefaultView`). The interface is public API; the class is
  internal.

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

Public entry points (e.g. `createClientSession()`) are factory functions that
instantiate and wire up the internal classes. Consumers never call `new
Default*` directly.

### Classes vs plain functions

- **Class** — when a component holds state, manages subscriptions, or has a
  lifecycle (construct/dispose). Most transport sub-components.
- **Plain function** — stateless transformations, one-shot utilities, codec
  encode/decode. Input in, output out, no retained state.

## Summary of principles

1. **Generic-vs-codec split** — the generic transport/codec knows nothing about
   any specific codec; each codec (Vercel, OpenAI, …) implements the `Codec`
   and provides wrappers.
2. **Codec/transport separation** — codec owns the wire format; transport owns
   sessions, runs, and state, parameterized by the codec.
3. **Codec-parameterized** — generic components are parameterized by
   `<TInput, TOutput, TProjection, TMessage>` via the `Codec` interface.
4. **Constructor/option injection** — no singletons, no globals.
5. **Composition, not inheritance** — compose features; no class hierarchies.
6. **Interface-first** — public contracts are interfaces; implementations are
   internal `Default*` classes, exposed via factory functions.
7. **Header discipline** — SDK metadata travels on the wire under an
   `extras.ai` envelope split into a transport tier (`extras.ai.transport`,
   always present) and an optional codec tier (`extras.ai.codec`). The generic
   layer reads and writes only the transport tier; codec-specific metadata
   belongs in the codec tier, owned by the codec layer.
8. **Explicit exports** — only what an `index.ts` re-exports is public API.
9. **Self-contained features** — each manages its own subscriptions, state, and
   cleanup.
10. **Single shared channel** — one Ably channel per transport, shared by all
    features.
