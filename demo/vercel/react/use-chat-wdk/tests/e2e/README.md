# End-to-end tests

Playwright tests that drive the demo in a browser and assert the user-visible
behaviour of a durable turn: a `useChat` client and a Vercel Workflow exchanging
AI messages over an Ably channel — streaming text, a client-executed tool, an
approval-gated tool, cancellation, and the retry that proves durability.

The suite needs no secrets:

- **Ably**: each run provisions a throwaway sandbox app over the sandbox REST
  API (as the SDK's integration tests do). Agent and browser both connect to the
  `nonprod:sandbox` endpoint, and the app gets an `ai` channel namespace with
  `mutableMessages` enabled (AIT streams by appending to messages).
- **LLM**: a deterministic mock model replaces the provider. Only token
  generation is mocked; `streamText`, tool execution, continuations,
  `toUIMessageStream`, and the Ably publish all run normally.
- **WDK**: `pnpm dev` runs the Workflow Development Kit locally and writes run
  state under `.workflow-data/` (gitignored). No Vercel account is involved.

## Running

```bash
pnpm run test:e2e                        # mock LLM + provisioned sandbox
pnpm run test:e2e -- --grep "retry"      # forward args to Playwright
pnpm run test:e2e:live                   # real Ably + LLM keys from .env.local
```

`test:e2e` runs the shared launcher (`demo/e2e/run-e2e.mjs`), which provisions
the sandbox app and sets, for the Playwright run and the Next.js dev server it
spawns:

| Variable                    | Value             | Used by                      |
| --------------------------- | ----------------- | ---------------------------- |
| `ABLY_API_KEY`              | sandbox key       | agent client, JWT auth route |
| `ABLY_ENDPOINT`             | `nonprod:sandbox` | activity clients             |
| `NEXT_PUBLIC_ABLY_ENDPOINT` | `nonprod:sandbox` | browser client               |
| `MOCK_LLM`                  | `1`               | `createModel()` (`model.ts`) |

Unset (normal `pnpm dev`), the demo uses production Ably and a real LLM provider.

## Two things specific to this demo

**The fault cookie.** The demo arms a one-shot fault from the UI, and it travels
as a cookie rather than in the POST body — the AIT chat transport owns that body.
The chat route consumes the cookie into the workflow input and clears it with the
same response, so a fault applies to exactly the turn that armed it. A test that
arms a fault must therefore send immediately afterwards.

**Longer waits than the other demos.** A durable turn runs as several processes:
the workflow starts, `openRun` publishes, one activity per inference, one per
server tool, then the terminal. Each is a separate WDK step with its own retry
policy, and the retry scenario deliberately fails an activity and waits for WDK
to re-run it. The assertions here use 90s timeouts for that reason; the same
assertions in `use-chat` run inside 30s.

The WDK processes panel is polled from the real Workflow observability API, so
its rows appear a beat behind the chat itself. Assert on the transcript first
and the panel second.
