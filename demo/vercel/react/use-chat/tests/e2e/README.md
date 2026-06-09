# End-to-end tests

Playwright tests that drive the demo in a browser and assert the user-visible
behaviour of the Ably AI Transport flow: client and agent sessions exchanging AI
messages over an Ably channel, rendered in the UI - streaming text, branch
navigation (edit/regenerate), client-side and approval-gated tools,
cancellation, history rebuild on refresh, and multi-tab observers.

The suite needs no secrets:

- **Ably**: each run provisions a throwaway sandbox app over the sandbox REST API
  (as the SDK's integration tests do). Agent and browser both connect to the
  `nonprod:sandbox` endpoint, and the app gets an `ai` channel namespace with
  `mutableMessages` enabled (AIT streams by appending to messages).
- **LLM**: a deterministic mock model replaces the provider. Only token
  generation is mocked; `streamText`, tool execution, suspend/continuation,
  `toUIMessageStream`, and the Ably publish all run normally.

## Running

```bash
pnpm run test:e2e                          # mock LLM + provisioned sandbox
pnpm run test:e2e -- --grep "fresh send"   # forward args to Playwright
pnpm run test:e2e:live                     # real Ably + LLM keys from .env.local
```

`test:e2e` runs `scripts/run-e2e.mjs`, which provisions the sandbox app and sets,
for the Playwright run and the Next.js dev server it spawns:

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

| Prompt                              | Reply                                                |
| ----------------------------------- | ---------------------------------------------------- |
| `Say "X" ...` / `... the word X`    | `X`                                                  |
| `what's the weather like?`          | `getLocation` (client tool, suspends), then text     |
| `... weather forecast for <place>?` | `getWeatherForecast` (approval, suspends), then text |
| `... a long story about a dragon`   | a long, slowly streamed, abort-aware reply           |

It chooses tool-call vs answer by whether the prompt already carries a tool
result or approval response. To add a scenario, add a `planResponse()` branch
keyed on the prompt.

## Known-failing tests (`test.fixme`)

Four specs are `test.fixme` - they catch SDK View-logic gaps (e.g. the View
orders reply runs by `startSerial` rather than prompt order). Each has a comment;
remove `.fixme` when the View logic is fixed.

- `regenerate on the follow-up text after a tool-call regen ...`
- `regenerate on tool-call after regenerating the follow-up text hides the orphaned text regenerator`
- `exploratory: mixed multi-prompt ...`
- `exploratory: regenerating an earlier prompt with later prompts present keeps the new response in-place`

## CI

The `demo-e2e` job in `.github/workflows/dev.yml` builds the SDK, installs the
demo and Chromium, and runs `pnpm run test:e2e`, uploading `test-results/` on
failure.
