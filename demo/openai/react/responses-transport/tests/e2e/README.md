# End-to-end tests

Playwright tests that drive the demo in a browser and assert the user-visible
behaviour of the Ably AI Transport flow with the OpenAI Responses codec: the
client and agent transports exchanging AI messages over an Ably channel,
rendered in the UI — streamed text, server-side / client-side / approval-gated
tool calls, cancellation, history rebuild on refresh (including a reload
mid-stream, which must merge to one message), and multi-tab sync.

This demo drives the client transport directly (`transport.publishInput` plus
an explicit `wakeAgent` POST) with the generic, codec-agnostic transport
parameterized by the OpenAI `ResponsesCodec`, and merges the decoded events
through OpenAI's own `accumulateResponse`. The thread is linear — there is no
branch navigation.

The suite needs no secrets:

- **Ably**: each run provisions a throwaway sandbox app over the sandbox REST API
  (as the SDK's integration tests do). Agent and browser both connect to the
  `nonprod:sandbox` endpoint, and the app gets an `ai` channel namespace with
  `mutableMessages` enabled (AIT streams by appending to messages).
- **Model**: a deterministic mock replaces OpenAI. The mock produces the same
  `ResponseStreamEvent` shape a real `/responses` text stream uses, so the codec,
  transport, run lifecycle, and Ably publish all run normally — only token
  generation is scripted.

## Running

```bash
pnpm run test:e2e                          # mock model + provisioned sandbox
pnpm run test:e2e -- --grep "fresh send"   # forward args to Playwright
pnpm run test:e2e:live                     # real Ably + OpenAI keys from .env.local
```

`test:e2e` runs the shared launcher (`demo/e2e/run-e2e.mjs`), which provisions
the sandbox app and sets, for the Playwright run and the Next.js dev server it
spawns:

| Variable                    | Value             | Used by                               |
| --------------------------- | ----------------- | ------------------------------------- |
| `ABLY_API_KEY`              | sandbox key       | agent client, JWT auth route          |
| `ABLY_ENDPOINT`             | `nonprod:sandbox` | agent client (`route.ts`)             |
| `NEXT_PUBLIC_ABLY_ENDPOINT` | `nonprod:sandbox` | browser client (`ably-provider.tsx`)  |
| `MOCK_LLM`                  | `1`               | `createResponseStream()` (`model.ts`) |

Unset (normal `pnpm dev`), the demo uses production Ably and the real OpenAI
Responses API.

## The mock model

`src/app/api/chat/mock-model.ts` is an `AsyncGenerator<ResponseStreamEvent>`
scripted from the last user prompt, wired in by `createResponseStream()` behind
`MOCK_LLM`:

| Prompt                            | Reply                                                      |
| --------------------------------- | ---------------------------------------------------------- |
| `Say "X" ...`                     | `X`                                                        |
| `... the word X ...`              | `X`                                                        |
| `... weather in <place>?`         | a `getWeather` function call, then a reply once it has run |
| `... a long story about a dragon` | a long, slowly streamed, abort-aware reply                 |
| `... marker X`                    | `Acknowledged the marker X.`                               |
| anything else                     | a short canned reply echoing the prompt                    |

To add a scenario, add a branch to `planReply()` keyed on the prompt. A weather
prompt drives the server-side tool path: the mock emits a `getWeather` call, the
agentic loop runs the tool and feeds the result back, and the mock then replies.
