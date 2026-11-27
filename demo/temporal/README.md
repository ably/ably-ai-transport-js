# Temporal demo

A chat whose agent runs as a Temporal workflow. Temporal's AI SDK plugin streams the model's output into the workflow's [Workflow Stream](https://github.com/temporalio/sdk-typescript/tree/main/contrib/workflow-streams), and the relay in `@ably/pubsub-server/temporal` publishes that stream to an Ably channel through AI Transport's `vercelTemporalRelayAdaptor()`. The page is `useChat` over AI Transport's chat transport.

Each turn goes like this:

1. `useChat` sends the conversation through the chat transport, which posts it to `/api/chat` and reads the reply off the chat's channel.
2. The route signals the turn to the chat's workflow, `chat-<chatId>`, and starts the workflow if it is not running.
3. The workflow publishes the reply's `start` chunk to its `turn` topic and calls `streamText` with a model from the plugin's `TemporalProvider`. The plugin runs the call as an Activity, which publishes each part of the model's stream to the `model` topic as it arrives. When the call ends, the workflow publishes `finish`.
4. The relay, a child workflow that `startAblyRelay` started, reads both topics in stream order. `vercelTemporalRelayAdaptor()` writes the workflow's chunks as they are, and turns the model's parts into the `UIMessageChunk`s `toUIMessageStream` would give, so the text streams as appends to one Ably message.
5. The chat transport hands the chunks to `useChat`, which merges them into the reply.

A chat's workflow takes one turn at a time, as the chat transport needs, and ends after ten minutes without one.

## Run it

The relay is not released yet. It is in [ably/ably-pubsub-js#2359](https://github.com/ably/ably-pubsub-js/pull/2359), and the demo installs `@ably/pubsub-server` from a clone of that repository next to this one, at `../../../ably-js`. Check out the pull request's branch there and build it:

```bash
cd ../../../ably-js && git checkout ait-1549-pr3-relay-activity && npm ci && npm run build && npm run build:temporal:types
```

Build this repository, so the demo gets the adaptor:

```bash
cd ../.. && pnpm install && pnpm run build
```

Install the demo and set the environment. The demo streams on `ai:*` channels, which need the `mutableMessages` channel rule. A new Ably app has it on the `ai` namespace; an app made before the rule existed needs it added once, or the first append fails with error `93002`. See [configure channel rules](https://ably.com/docs/ai-transport/getting-started/channel-rules).

```bash
cp .env.local.example .env.local   # add your Ably API key; MOCK_LLM=1 needs no model key
pnpm install
```

Run a Temporal dev server, the worker and the app, each in its own terminal:

```bash
temporal server start-dev
```

```bash
pnpm run worker
```

```bash
pnpm run dev
```

Open http://localhost:3000, send a message, and watch the reply stream. The Temporal UI at http://localhost:8233 shows the chat workflow, its relay and the model Activities.

## What is in it

- `src/temporal/workflows.ts` is the chat workflow. It starts the relay with one route that reads the `turn` and `model` topics, and re-exports `ablyRelayWorkflow` so the worker registers it.
- `src/temporal/worker.ts` is the worker. It registers the AI SDK plugin with the model, and the relay plugin with a channel pool and `vercelTemporalRelayAdaptor()` under the name the route uses.
- `src/temporal/model.ts` picks the model: the mock when `MOCK_LLM=1`, otherwise Anthropic or OpenAI, whichever key is set. The workflow asks for it as `chat`.
- `src/app/api/chat/route.ts` signals each turn to the chat's workflow, starting it if needed.
- `src/app/api/auth/ably-token/route.ts` issues Ably token requests for the browser.
- `src/app/page.tsx` is `useChat` with AI Transport's chat transport on the chat's channel.
- `src/shared/chat.ts` holds what the page, the route and the workflow share.

## Limits

- The page keeps the conversation, and the route sends all of it with each turn. A refresh starts a new chat.
- A retried model Activity publishes its parts again after the failed attempt's, and a retried relay activity writes the events since its last checkpoint again, so a reply can show some text twice.
- The workflow does not continue as new, so a very long chat grows its history until it goes idle.
