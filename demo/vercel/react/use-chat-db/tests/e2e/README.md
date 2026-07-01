# End-to-end tests

Playwright tests that drive the database-hydration demo in a browser and assert
the user-visible behaviour over a real Ably channel: the agent persists each
completed run's messages (the whole run) to the store, and on reload the client seeds
`useChat` from the store and `useMessageSync` reconciles it with the live
channel at the seam, showing the conversation exactly once. The suite covers a
plain text turn, a client-executed tool that suspends and resumes the run
(getLocation), and an approval-gated tool (getWeatherForecast) whose tool-call
message stays shown as approved after hydration.

The suite needs no secrets:

- **Ably**: each run provisions a throwaway sandbox app over the sandbox REST API
  (as the SDK's integration tests do). Agent and browser both connect to the
  `nonprod:sandbox` endpoint, and the app gets an `ai` channel namespace with
  `mutableMessages` and persistence enabled.
- **LLM**: a deterministic mock model replaces the provider. Only token
  generation is mocked; `streamText`, tool execution, suspend/continuation,
  `toUIMessageStream`, the Ably publish, and the store write all run normally.

## Running

```bash
pnpm run test:e2e                          # mock LLM + provisioned sandbox
pnpm run test:e2e -- --grep "reload"       # forward args to Playwright
pnpm run test:e2e:live                     # real Ably + LLM keys from .env.local
```

`test:e2e` runs the shared launcher (`demo/e2e/run-e2e.mjs`), which provisions
the sandbox app and sets, for the Playwright run and the Next.js dev server it
spawns:

| Variable                    | Value             | Used by                          |
| --------------------------- | ----------------- | -------------------------------- |
| `ABLY_API_KEY`              | sandbox key       | agent client, JWT auth route     |
| `ABLY_ENDPOINT`             | `nonprod:sandbox` | agent client (`route.ts`)        |
| `NEXT_PUBLIC_ABLY_ENDPOINT` | `nonprod:sandbox` | browser client (`providers.tsx`) |
| `MOCK_LLM`                  | `1`               | `createModel()` (`model.ts`)     |

Unset (normal `pnpm dev`), the demo uses production Ably and a real LLM provider.

## The mock model

`src/app/api/chat/mock-model.ts` is a Vercel AI SDK `LanguageModel` whose output
is scripted from the prompt, wired in by `createModel()` behind `MOCK_LLM`:

| Prompt                              | Reply                                                   |
| ----------------------------------- | ------------------------------------------------------- |
| `Say "X"` / `... the word X`        | `X`                                                     |
| `... marker X`                      | `Acknowledged marker X.`                                |
| `what's the weather like?`          | `getLocation` (client tool, suspends), then a sentence  |
| `... weather forecast for <place>?` | `getWeatherForecast` (approval, suspends), then a reply |
| `... a long story about a dragon`   | a long, slowly streamed, abort-aware reply              |
| anything else                       | `Done.`                                                 |

## CI

The `demo-e2e` job in `.github/workflows/dev.yml` builds the SDK, installs the
demo and Chromium, and runs `pnpm run test:e2e`, uploading `test-results/` on
failure.
