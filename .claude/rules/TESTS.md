# Testing Strategy

## Two tiers

| Tier | Command | Runs against | What it proves |
|---|---|---|---|
| **Unit** | `npm test` | Mocks only | Every code path works correctly in isolation |
| **Integration** | `npm run test:integration` | Real Ably channels | Happy path works end-to-end over real Ably |

Config: `vitest.config.ts` (unit, excludes `*.integration.test.ts`) and `vitest.config.integration.ts` (integration only).

## Unit tests

### Scope

Every exported function and every non-trivial internal module gets its own `__tests__/<module>.test.ts` file. Aim for 90%+ line coverage on non-React code, 80%+ on React hooks.

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
- State machine transitions (turn lifecycle, cancel routing)
- Invalid input validation
- React hook lifecycle (with `renderHook` / jsdom)

## Integration tests

### Scope

Prove the system works over real Ably. Don't duplicate unit-test edge cases. Each test exercises a user-visible scenario end-to-end. Use fixture chunk streams (deterministic, no LLM calls needed).

Integration tests can be written at two levels:

- **Codec level**: Test encode/decode roundtrips over a real Ably channel without standing up a full transport. A codec-level test publishes encoded messages to a channel and verifies the decoder reconstructs the expected output. This validates the wire format and Ably message serialization without transport machinery.
- **Transport level**: Test the full send → stream → receive lifecycle through `ClientTransport` and `ServerTransport`. This validates the complete system including turn management, stream routing, and history hydration.

### Environment

By default, integration tests run against the **Ably sandbox**. The globalSetup (`test/helper/test-setup.ts`) provisions a temporary app via the sandbox REST API — no API key or secrets are needed.

To run against a different environment, set `VITE_ABLY_ENV`:

| `VITE_ABLY_ENV` | Behaviour | API key required? |
|---|---|---|
| *(unset)* / `sandbox` | Provisions a sandbox app automatically | No |
| `local` | Connects to `local-rest.ably.io:8081` (no TLS) | Yes — set `VITE_ABLY_API_KEY` |
| `production` | Connects to production Ably | Yes — set `VITE_ABLY_API_KEY` |

### Conventions

- Unique channel names per test via `uniqueChannelName()` to avoid crosstalk
- Clean up clients in `afterEach` via `closeAllClients()`
- 30s test timeout; individual tests should complete in 2-5s
- Helpers live in `src/__tests__/integration/helpers.ts`

### Scenarios to cover

Happy-path scenarios that validate the wire protocol and real Ably behavior:

1. Text response roundtrip (codec level)
2. Tool call roundtrip (codec level)
3. Full transport: send -> stream -> receive
4. Tool call through transport
5. Cancel chain: client cancel -> server abort -> stream closes
6. Multi-turn sequential
7. Concurrent turns
8. History hydration: stream a turn, new client hydrates from channel history via `decodeHistory`
9. Reconnect / resume: client disconnects mid-stream, reconnects, receives the rest
10. Conversation tree / branching: send, regenerate (fork), verify tree from history
11. Error propagation: server error mid-stream, client receives and stream closes cleanly
12. Multi-client sync: two clients on the same channel both see the streamed response

### What NOT to integration test

- Encoding/decoding edge cases (unit tests)
- Error handler isolation (unit tests)
- Invalid input validation (unit tests)
- React hook lifecycle (unit tests with jsdom)
