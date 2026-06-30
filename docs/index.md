# AI Transport

`@ably/ai-transport` is a transport layer for AI applications built on [Ably](https://ably.com). It handles real-time streaming between your server (where the LLM runs) and your clients (where users interact) over Ably channels - with built-in support for cancellation, conversation branching, history, and multi-client sync.

The SDK is codec-parameterized: a generic transport core handles streaming, runs, and state management, while a pluggable codec translates between your framework's types and the Ably wire format. The Vercel AI SDK codec ships out of the box.

## Entry points

| Import path                       | What it provides                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `@ably/ai-transport`              | Generic transport, codec interfaces, utilities. Framework-agnostic.                        |
| `@ably/ai-transport/react`        | React hooks for the generic transport (`useClientSession()`, `useView()`, etc.)            |
| `@ably/ai-transport/vercel`       | Vercel AI SDK integration - `UIMessageCodec` and pre-bound transport factories             |
| `@ably/ai-transport/vercel/react` | Vercel-specific React hooks - `useChatTransport()` for `useChat()`, `useMessageSync()`     |
| `@ably/ai-transport/openai`       | OpenAI Responses codec - `ResponsesCodec` (early preview; text prompts + streamed replies) |

Peer dependencies: `ably` (required), `ai` (for Vercel entry points), `openai` (for the OpenAI entry point), `react` (for React entry points).

## Where to start

**Understand the architecture** - read [Client and agent sessions](concepts/sessions.md), [Runs](concepts/runs.md), and [Message lifecycle](internals/message-lifecycle.md) to build a mental model of how data flows.

**Build something** - follow the [Get Started with useChat](get-started/vercel-use-chat.md) quickstart to have a working streaming chat app in minutes. Or use the [generic hooks quickstart](get-started/vercel-use-client-session.md) for more control.

**Add a feature** - the [Features](features/) section covers streaming, cancellation, interruption, optimistic updates, history, conversation branching, multi-client sync, presence, and LiveObjects.

**Look up an API** - the [Reference](reference/) section has complete signatures for all React hooks and error codes.

## Status

This SDK is pre-release (v0.1.0). The Vercel AI SDK is the most complete framework integration today; an OpenAI Responses codec is in early preview (text prompts and streamed assistant replies). The generic transport and codec interfaces support custom integrations, and more framework codecs are planned.
