# Abstractions

## Directory Layout

```
src/
├── core/               # Core SDK — no model/agent library/framework -specific dependencies
│   ├── codec/          # Core codec definitions
│   └── transport/      # Core transport definitions
├── react/              # React bindings
│   ├── hooks/          # React hooks - one file per hook
│   │   └── internal/   # Shared hook helpers (not exported)
│   ├── providers/      # React providers - one file per provider
│   ├── contexts/       # React contexts - one file per context
│   └── types/          # Shared React-specific types
├── vercel/             # Vercel AI SDK specific implementations
│   ├── codec/          # Vercel codec definition
│   └── transport/      # Vercel transport definitions
├── index.ts            # Entry point for @ably/ai-transport
└── vite.config.ts      # Build config for the main bundle

test/
├── core/               # Mirrors src/core/ — unit + integration tests
├── react/              # Mirrors src/react/
│   └── helper/         # React-specific test helpers
└── helper/             # Shared test utilities, custom matchers, setup

__mocks__/                            # Module mocks (ably) for unit tests
demo/                                 # Standalone demo apps (separate package.json)
└── vercel/                           # Vercel AI SDK demos
    └── react/                        # Vercel AI SDK React demos
        └── use-chat/                 # Demo using useChat
        └── use-client-transport/     # Demo using useClientTransport
scripts/                              # Build and validation scripts
ably-common/                          # Git submodule — shared protocol resources
```

## Package Exports

The SDK ships four entry points from a single package:

| Export path | Contains | Purpose | External deps |
|---|---|---|---|
| `@ably/ai-transport` | Generic codec interfaces, `createClientTransport`, `createServerTransport`, shared utilities | Core primitives — codec-agnostic transport and encoding | `ably` (peer) |
| `@ably/ai-transport/react` | `useClientTransport`, `useMessages`, `useSend`, `useRegenerate`, `useEdit`, `useActiveTurns`, `useHistory`, `useConversationTree`, `useAblyMessages` | Generic React hooks for any codec | `ably`, `react` (peers) |
| `@ably/ai-transport/vercel` | `UIMessageCodec`, `createServerTransport`, `createClientTransport`, `createChatTransport`, Vercel-specific types | Drop-in Vercel AI SDK integration | `ably`, `ai` (peers) |
| `@ably/ai-transport/vercel/react` | `useChatTransport`, `useMessageSync` | React hooks for Vercel's `useChat` | `ably`, `ai`, `react` (peers) |


## Two-Layer Architecture

The codebase is split into a **generic layer** and a **Vercel layer**:

### Generic layer (`src/core/`, `src/react/`)

Defines the `Codec<TEvent, TMessage>` interface and provides `ClientTransport`, `ServerTransport`, `ConversationTree`, and `decodeHistory` — all parameterized by codec. Framework-agnostic; knows nothing about Vercel's `UIMessageChunk` or `UIMessage`. Uses only `x-ably-*` headers — must never reference codec-specific domain headers.

### Vercel layer (`src/vercel/`)

Implements `UIMessageCodec` and provides convenience factories plus React hooks. The `ChatTransport` adapter wraps a generic `ClientTransport` to satisfy the `ChatTransport` interface that `useChat` expects.

### Shared (`src/constants.ts`, `src/utils.ts`)

Header/event/message-name constants and Ably message utilities used by both layers.

## Composition, Not Inheritance

The SDK uses composition, not inheritance. For example, a transport is assembled from composable sub-components:

```
ClientTransport
├── Codec (encoder + decoder + accumulator)
├── ConversationTree — branching message history
├── MessageStore — flat message state, delegates to tree
├── MessageDispatcher — routes decoded events to store/streams
├── StreamRouter — maps turn-scoped events to ReadableStream controllers
├── TurnManager — tracks active turns by clientId
├── CancelPublisher — publishes cancel signals to the channel
└── ObserverAccumulator — accumulates messages from observer events

ServerTransport
├── Codec (encoder)
├── TurnManager — tracks active turns for cancel routing
└── Turn (per request)
    ├── Encoder instance
    └── pipeStream — pipes ReadableStream through encoder
```

## Dependency Injection

All dependencies are passed through constructors. There are no singletons or service locators.

## Class Pattern

Use ES6 classes with the **Interface + Default Implementation** pattern:

- Define a public **interface** for the contract (e.g. `ClientTransport`, `MessageStore`).
- Implement it with a **`Default*` class** (e.g. `DefaultClientTransport`, `DefaultMessageStore`).
- Export the interface as public API; the class is internal.

### Private state

Use TypeScript `private readonly` fields with underscore prefix. Store all constructor-injected dependencies as private fields:

```ts
class DefaultMessageStore<TMessage> implements MessageStore<TMessage> {
  private readonly _tree: ConversationTree<TMessage>;
  private readonly _logger: Logger;

  constructor(tree: ConversationTree<TMessage>, logger: Logger) {
    this._tree = tree;
    this._logger = logger.withContext({ component: 'MessageStore' });
  }
}
```

### Property access

Expose public state via getters that return the interface type, not the implementation:

```ts
get messages(): Messages {
  return this._messages;
}
```

### Factory functions as entry points

Public-facing entry points (e.g. `createClientTransport()`) are factory functions that instantiate and wire up the internal classes. Consumers never call `new Default*` directly.

### When to use classes vs plain functions

- **Class**: When a component holds state, manages subscriptions, or has a lifecycle (construct/dispose). Most transport sub-components fall here.
- **Plain function**: Stateless transformations, one-shot utilities, codec encode/decode functions. If it takes input and returns output with no retained state, it should be a function.

## Summary of Principles

1. **Two-layer split**: Generic transport/codec knows nothing about Vercel. Vercel layer implements the codec and provides convenience wrappers.
2. **Codec-parameterized**: All generic components are parameterized by `<TEvent, TMessage>` via the `Codec` interface.
4. **Constructor/option injection**: All dependencies passed explicitly — no singletons, no globals.
3. **Composition, not inheritance**: Transports compose features; no class hierarchies.
5. **Interface-first**: Public contracts are TypeScript interfaces. Implementations are internal `Default*` classes, exposed to consumers via factory functions.
6. **Header discipline**: Generic layer uses only `x-ably-*` headers. Domain-specific headers (e.g. `x-domain-*`) belong in the Vercel layer.
7. **Explicit exports**: Only types and functions listed in `index.ts` files are public API.
8. **Features are self-contained**: Each feature manages its own subscriptions, state, and cleanup.
9. **Single shared channel**: One Ably channel per transport, shared by all features.
