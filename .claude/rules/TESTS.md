# Testing Strategy

## Three tiers

| Tier            | Command                     | Runs against          | What it proves                                        |
| --------------- | --------------------------- | --------------------- | ----------------------------------------------------- |
| **Unit**        | `pnpm test`                 | Mocks only            | Every code path works correctly in isolation          |
| **Integration** | `pnpm run test:integration` | Real Ably channels    | Happy path works end-to-end over real Ably            |
| **Temporal**    | `pnpm run test:temporal`    | A Temporal dev server | Shipped workflow code behaves inside the real sandbox |

Config: `vitest.config.ts` (unit, excludes both other tiers by filename),
`vitest.config.integration.ts` (`*.integration.test.ts`) and
`vitest.config.temporal.ts` (`*.temporal.test.ts`).

### The Temporal tier

Only for the workflow-side code in `src/temporal/workflow/`. Workflow code cannot
be called directly — Temporal has to run it — so these boot a throwaway server
via `TestWorkflowEnvironment` and bundle fixture workflows through a real
`Worker`. That bundling is itself a test: a worker-side import leaking into the
workflow half fails here, because the sandbox has no `ably` and no
`@temporalio/activity`.

Keep it to what only a real execution can prove: which activities get scheduled
and in what order, cleanup firing on failure and surviving cancellation, and
determinism on replay. Activity bodies are faked — their behaviour belongs in the
unit tier. This tier needs no Ably credentials and touches no channel.

## Unit tests

### Scope

Every exported function and every non-trivial internal module gets its own test file. Tests live under `test/`, mirroring the `src/` layout. Aim for 90%+ line coverage on non-React code, 80%+ on React hooks.

### Style

- Mock writers that record calls (`createMockWriter`, `createMockChannel`)
- `flushMicrotasks()` instead of `setTimeout` — never use timeouts in tests
- `mockFetch.nextCall()` / `mockFetch.waitForCalls(n)` to await fire-and-forget POSTs
- `mockChannel.waitForPublishes(n)` to await encoder publish operations
- `simulateMessage()` for synchronous channel event simulation
- For streams that stay open, simulate a terminal event (`finish`) to close deterministically, then drain with `reader.read()`

### What to unit test

- All code paths in every module: success, error, edge cases
- Error handler isolation (one throwing handler doesn't kill others)
- State machine transitions (run lifecycle, cancel routing)
- Invalid input validation
- React hook lifecycle (with `renderHook` / jsdom)

## Integration tests

### Scope

Prove the system works over real Ably. Don't duplicate unit-test edge cases. Each test exercises a user-visible scenario end-to-end. Use fixture chunk streams (deterministic, no LLM calls needed).

Integration tests can be written at two levels:

- **Codec level**: Test encode/decode roundtrips over a real Ably channel without standing up a full transport. A codec-level test publishes encoded messages to a channel and verifies the decoder reconstructs the expected output. This validates the wire format and Ably message serialization without transport machinery.
- **Transport level**: Test the full send → stream → receive lifecycle through `ClientTransport` and `AgentTransport`. This validates the complete system including run management, stream routing, and history paging.

### Environment

By default, integration tests run against the **Ably sandbox**. The globalSetup (`test/helper/test-setup.ts`) provisions a temporary app via the sandbox REST API — no API key or secrets are needed.

To run against a different environment, set `VITE_ABLY_ENV`:

| `VITE_ABLY_ENV`       | Behaviour                                      | API key required?             |
| --------------------- | ---------------------------------------------- | ----------------------------- |
| _(unset)_ / `sandbox` | Provisions a sandbox app automatically         | No                            |
| `local`               | Connects to `local-rest.ably.io:8081` (no TLS) | Yes — set `VITE_ABLY_API_KEY` |
| `production`          | Connects to production Ably                    | Yes — set `VITE_ABLY_API_KEY` |

Independently, setting `ABLY_LOCAL_SANDBOX_URL` (e.g. `http://localhost:9010`) points app provisioning at a **local sandbox** — a provisioner fronting a local Ably-compatible server — instead of the cloud. The globalSetup provisions the app through that sandbox's `POST /apps`, and clients route at the isolated server it reports (its own endpoint/port/tls). This is the inert support the ably-server compatibility harness drives; it takes precedence over `VITE_ABLY_ENV` and is a no-op (cloud path unchanged) when unset.

### Conventions

- Unique channel names per test via `uniqueChannelName()` to avoid crosstalk
- Clean up clients in `afterEach` via `closeAllClients()`
- 30s test timeout; individual tests should complete in 2-5s
- Integration helpers live in `test/integration/helpers.ts`

### Scenarios to cover

Happy-path scenarios that validate the wire protocol and real Ably behavior:

1. Text response roundtrip (codec level, folded through the provider's own reducer)
2. Tool call roundtrip (codec level)
3. Full transport: send -> stream -> receive
4. Tool call through transport
5. Cancel chain: client cancel -> server abort -> stream closes
6. Multi-run sequential
7. Concurrent runs
8. History paging: stream a run, a fresh client pages the channel to chronological batches
9. Attach boundary: a run streaming across the attach point folds to one message (the shared live/history decoder), not a duplicated prefix
10. Error propagation: server error mid-stream, client receives and stream closes cleanly
11. Multi-client sync: two clients on the same channel both see the streamed response
12. Durable cross-process re-entry: a second transport adopts the run via `adoptRun` and publishes only the terminal

### What NOT to integration test

- Encoding/decoding edge cases (unit tests)
- Error handler isolation (unit tests)
- Invalid input validation (unit tests)
- React hook lifecycle (unit tests with jsdom)
