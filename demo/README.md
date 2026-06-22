# Demos

Working demo applications for `@ably/ai-transport`. Each demo is a full,
runnable application — not a snippet — that shows how to build with the SDK
against a particular stack.

## Available demos

| Demo                                                                     | Stack                                | Shows                                                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`vercel/react/use-chat/`](./vercel/react/use-chat/)                     | Next.js + Vercel AI SDK              | The SDK wired into Vercel's [`useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) hook via `useChatTransport` and `useMessageSync` |
| [`vercel/react/use-client-session/`](./vercel/react/use-client-session/) | Next.js + `@ably/ai-transport/react` | The lower-level React hooks (`useClientSession`, `useView`, …) driving a session directly, without `useChat`                                   |

Each demo aims to exercise as much of the SDK's public API as possible, so a
single demo shows the breadth of what AI Transport can do rather than one
feature in isolation. Where the stack allows, the demos offer the same
application built different ways, so you can compare ecosystems directly.

Each demo has its own README with prerequisites and setup. Shared end-to-end
test scaffolding lives in [`e2e/`](./e2e/).
