# Demos

Guidance for creating and maintaining the demos under `demo/`.

## Purpose

Each demo is one complete, runnable application that exercises **as much of the
public API for `@ably/ai-transport` as possible** — sending, streaming, runs,
cancellation, history hydration, branching, the React hooks, and so on. A demo
demonstrates how the pieces fit together in a real app; it is not a snippet
isolating a single call.

## Extend vs. create

The default is to **extend an existing demo**, not add a new one.

- **Extend** when new functionality fits inside an existing application. As
  features land in the SDK, fold them into the existing demos so a reader sees
  the breadth of the API in context. Do **not** create a demo whose purpose is
  to showcase one feature in isolation.
- **Create a new demo** only when the application has to be **architected or
  deployed differently** — a structural difference that forces a different
  application shape, not a feature toggle. For example:
  - **Deployment platform** — e.g. Vercel vs. Temporal.
  - **Agent execution model** — e.g. serverless vs. durable execution.
  - **Codec or harness** — e.g. AG-UI vs. Vercel `UIMessage` vs. the Anthropic
    Agents SDK.
  - **UI framework** — e.g. React vs. Vue vs. Svelte.

When in doubt: if it fits inside an existing app, extend that app; if it
requires a different application shape, it's a new demo.

## Consistency across demos

We want the **same application built different ways**. Where it doesn't conflict
with the stack being demonstrated, keep the user-facing experience — the
features exercised, the UI, the overall flow — consistent across demos, so the
stacks can be compared directly.

## Keep the human-facing README current

`demo/README.md` is the consumer-facing index of the demos. When you add a demo,
add it to that table; when a demo's purpose or stack changes, update its row.
