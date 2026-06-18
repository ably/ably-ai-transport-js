# Abstractions

## Layout

The generic layer lives in `src/core/` and `src/react/`; the Vercel layer in
`src/vercel/` (and `src/vercel/react/`). Within each layer, `codec/` and
`transport/` are separate concerns. Shared header/event/message-name constants
and Ably message helpers sit at the top of `src/` (`constants.ts`, `utils.ts`).
Tests mirror `src/` under `test/`.

The package ships four entry points, each with its own `index.ts`. That
`index.ts` is the authoritative list of what is public — only types and
functions it re-exports are public API.

| Entry point                       | Purpose                                                                                                          | Peer deps             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| `@ably/ai-transport`              | Core, codec-agnostic transport and codec interfaces (`createClientSession`, `createAgentSession`, `defineCodec`) | `ably`                |
| `@ably/ai-transport/react`        | Generic React hooks and providers for any codec                                                                  | `ably`, `react`       |
| `@ably/ai-transport/vercel`       | Vercel AI SDK codec, convenience factories, and the chat-transport adapter                                       | `ably`, `ai`          |
| `@ably/ai-transport/vercel/react` | React hooks for Vercel's `useChat`                                                                               | `ably`, `ai`, `react` |

## Two-layer architecture

The codebase splits into a **generic layer** and a **Vercel layer**. This
separation is the most important invariant to preserve:

- **Generic layer** (`src/core/`, `src/react/`) — defines the
  `Codec<TEvent, TMessage>` interface and the codec-parameterized transport
  (`ClientSession`, `AgentSession`, `Tree`, conversation loading). It is
  framework-agnostic: it must know nothing about Vercel's `UIMessageChunk` or
  `UIMessage`, and must read or write only transport-tier metadata — never
  codec-specific domain metadata (see header discipline below).
- **Vercel layer** (`src/vercel/`) — implements the codec for the Vercel AI
  SDK and provides convenience factories plus React hooks. Its chat-transport
  adapter wraps a generic `ClientSession` to satisfy the interface `useChat`
  expects.

Codec and transport are themselves distinct: the **codec** owns the wire
format (encode/decode of events and messages); the **transport** owns sessions,
runs, channel I/O, and conversation state. The transport is parameterized by
the codec and never hardcodes a wire format.

## Tree / View / Session split

The client side separates three concerns, with the Tree as the single source
of truth:

- **Tree** — complete conversation state (every node, from live messages and
  history) and active-run tracking. Emits unfiltered events for every change.
- **View** — a pagination projection over the Tree: which history-loaded nodes
  are visible, re-emitting the Tree's events scoped to the visible window.
- **Session** — the write path (send/regenerate/edit/cancel), channel
  subscription, and decode loop. Wires the channel into the Tree and exposes
  both as `session.tree` and `session.view`. Surfaces only an `error` event;
  all data events live on the Tree and View.

## Composition, not inheritance

Sessions are assembled from composable parts, not class hierarchies. A
`ClientSession` composes the codec, the Tree (state) and View (projection), and
the channel subscription + decode loop. An `AgentSession` composes the codec's
encoder with per-run stream piping and run tracking for cancel routing.

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
class DefaultView<TEvent, TMessage> implements View<TMessage> {
  private readonly _tree: TreeInternal<TMessage>;
  private readonly _logger: Logger;

  constructor(options: ViewOptions<TEvent, TMessage>) {
    this._tree = options.tree;
    this._logger = options.logger.withContext({ component: 'View' });
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

1. **Two-layer split** — the generic transport/codec knows nothing about
   Vercel; the Vercel layer implements the codec and provides wrappers.
2. **Codec/transport separation** — codec owns the wire format; transport owns
   sessions, runs, and state, parameterized by the codec.
3. **Codec-parameterized** — generic components are parameterized by
   `<TEvent, TMessage>` via the `Codec` interface.
4. **Constructor/option injection** — no singletons, no globals.
5. **Composition, not inheritance** — compose features; no class hierarchies.
6. **Interface-first** — public contracts are interfaces; implementations are
   internal `Default*` classes, exposed via factory functions.
7. **Header discipline** — SDK metadata travels on the wire under an
   `extras.ai` envelope split into a transport tier (`extras.ai.transport`,
   always present) and an optional codec tier (`extras.ai.codec`). The generic
   layer reads and writes only the transport tier; codec-specific metadata
   belongs in the codec tier, owned by the codec/Vercel layer.
8. **Explicit exports** — only what an `index.ts` re-exports is public API.
9. **Self-contained features** — each manages its own subscriptions, state, and
   cleanup.
10. **Single shared channel** — one Ably channel per transport, shared by all
    features.
