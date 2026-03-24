# AI Transport

`@ably/ably-ai-transport-js` is a transport layer for AI applications built on [Ably](https://ably.com). It handles real-time streaming between your server (where the LLM runs) and your clients (where users interact) over Ably channels — with built-in support for cancellation, conversation branching, history, and multi-client sync.

The SDK is codec-parameterized: a generic transport core handles streaming, turns, and state management, while a pluggable codec translates between your framework's types and the Ably wire format. The Vercel AI SDK codec ships out of the box.

## Entry points

| Import path                               | What it provides                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@ably/ably-ai-transport-js`              | Generic transport, codec interfaces, utilities. Framework-agnostic.                          |
| `@ably/ably-ai-transport-js/react`        | React hooks for the generic transport (`useClientTransport`, `useMessages`, `useSend`, etc.) |
| `@ably/ably-ai-transport-js/vercel`       | Vercel AI SDK integration — `UIMessageCodec` and pre-bound transport factories               |
| `@ably/ably-ai-transport-js/vercel/react` | Vercel-specific React hooks — `useChatTransport` for `useChat`, `useMessageSync`             |

Peer dependencies: `ably` (required), `ai` (for Vercel entry points), `react` (for React entry points).

## Where to start

**Understand the architecture** — read [Client and server transport](concepts/transport.md), [Turns](concepts/turns.md), and [Message lifecycle](internals/message-lifecycle.md) to build a mental model of how data flows.

**Build something** — follow the [Get Started with useChat](get-started/vercel-use-chat.md) quickstart to have a working streaming chat app in minutes. Or use the [generic hooks quickstart](get-started/vercel-use-client-transport.md) for more control.

**Add a feature** — the [Features](features/) section covers streaming, cancellation, barge-in, history, conversation branching, multi-client sync, and tool calls.

**Look up an API** — the [Reference](reference/) section has complete signatures for all React hooks and error codes.

## Status

This SDK is pre-release (v0.0.1). The Vercel AI SDK is the only supported framework today. The generic transport and codec interfaces support custom integrations — additional framework codecs are planned.
