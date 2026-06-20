# Demos

Working demo applications for `@ably/ai-transport`. Each demo is a full,
runnable application — not a snippet — that shows how to build with the SDK
against a particular stack.

## Available demos

| Demo | Stack | Shows |
| ---- | ----- | ----- |
| [`vercel/react/use-chat/`](./vercel/react/use-chat/) | Next.js + Vercel AI SDK | The SDK wired into Vercel's [`useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) hook via `useChatTransport` and `useMessageSync` |
| [`vercel/react/use-client-session/`](./vercel/react/use-client-session/) | Next.js + `@ably/ai-transport/react` | The lower-level React hooks (`useClientSession`, `useView`, …) driving a session directly, without `useChat` |

Each demo has its own README with prerequisites and setup. Shared end-to-end
test scaffolding lives in [`e2e/`](./e2e/).

## What belongs in a demo

These demos exist to **demonstrate the SDK's public API in a realistic
application**. The guiding principles:

### One application, exercised as fully as possible

A demo aims to be a complete, working application that exercises **as much of
the public API surface for AI Transport as possible** — sending, streaming,
runs, cancellation, history hydration, branching, the React hooks, and so on.
The goal is to show how the pieces fit together in a real app, not to isolate
one call.

### Extend existing demos for new features — don't add feature-specific demos

As new features land in the SDK, **extend the existing demos** to incorporate
them. Do **not** create a new demo whose purpose is to showcase a single
feature in isolation. A reader should be able to open one demo and see the
breadth of the API in context, rather than hunting across many narrow demos.

### Add a new demo only for a genuinely different stack

A separate demo is warranted when an application has to be **architected or
deployed differently** — i.e. the difference is structural, not a feature
toggle. For example:

- **Deployment platform** — e.g. Vercel vs. Temporal.
- **Agent execution model** — e.g. serverless functions vs. durable execution.
- **Codec or harness** — e.g. AG-UI vs. Vercel `UIMessage` vs. the Anthropic
  Agents SDK.
- **UI framework** — e.g. React vs. Vue vs. Svelte.

When in doubt: if the new thing fits inside an existing app as additional
functionality, extend that app; if it requires a different application shape,
it's a new demo.

### Keep the experience consistent across demos

We want the **same application built different ways**. Where it doesn't conflict
with the stack being demonstrated, keep the user-facing experience — the
features exercised, the UI, the overall flow — as consistent as possible
between demos. This lets a reader compare stacks directly and see how the same
application is expressed across different ecosystems.
