# Testing Strategy

## Two tiers

| Tier            | Command                     | Runs against       | What it proves                               |
| --------------- | --------------------------- | ------------------ | -------------------------------------------- |
| **Unit**        | `pnpm test`                 | Mocks only         | Every code path works correctly in isolation |
| **Integration** | `pnpm run test:integration` | Real Ably channels | Happy path works end-to-end over real Ably   |

Config: `vitest.config.ts` (unit, excludes the integration tier by filename)
and `vitest.config.integration.ts` (`*.integration.test.ts`).

## Unit tests

### Scope

Every exported function and every non-trivial internal module gets its own test file. Tests live under `test/`, mirroring the `src/` layout. Aim for 90%+ line coverage.

### Style

- Mock the channel and the writer rather than the Ably SDK; shared mocks live in `test/helper/`
- `flushMicrotasks()` instead of `setTimeout` — never use timeouts in tests
- For streams that stay open, simulate a terminal event (`finish`) to close deterministically, then drain the reader

### What to unit test

- All code paths in every module: success, error, edge cases
- Error handler isolation (one throwing handler doesn't kill others)
- State machine transitions (run lifecycle, cancel routing)
- Invalid input validation

## Integration tests

### Scope

Prove the system works over real Ably. Don't duplicate unit-test edge cases. Each test exercises a user-visible scenario end-to-end. Use fixture chunk streams (deterministic, no LLM calls needed).

Integration tests can be written at two levels:

- **Codec level**: Test encode/decode roundtrips over a real Ably channel without standing up a full transport. A codec-level test publishes encoded messages to a channel and verifies the decoder reconstructs the expected output. This validates the wire format and Ably message serialization without transport machinery.
- **Transport level**: exercise send → stream → receive through `ClientTransport` and `AgentTransport` over a real channel — run lifecycle, stream routing, steering, cancel, and history paging.

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
- Shared test helpers live in `test/helper/`

### What the tier covers today

Codec level only, in `test/vercel/codec/wire-codec.integration.test.ts`: a text
and tool-call roundtrip over a real channel, proving the wire format and Ably's
message serialization.

**Transport-level integration coverage is outstanding.** The suite that covered
it was deleted with the session layer it exercised, and no replacement has been
written. Treat the list below as the work to do, not a description of what
exists — every row is currently untested over real Ably.

1. Full transport: send → stream → receive
2. Tool call through transport
3. Cancel chain: client cancel → agent abort → stream closes
4. Multi-run sequential, and concurrent runs
5. Steering: a steer lands on an open run and its outcome resolves
6. History paging: a fresh client pages backwards and receives chronological batches of classified events
7. Attach boundary: a run streaming across the attach point yields one message's worth of events, not a duplicated prefix
8. Durable cross-process re-entry: a second transport adopts an open run and ends it
9. Error propagation: agent error mid-stream, client observes the run's error terminal
10. Multi-client sync: two clients on the same channel both see the streamed response

Until those land, the transport's contract rests on the unit tier, which drives
both transports against a mock channel. `test/core/transport/codec-transport.test.ts`
is the one unit test that composes a real codec with both real transports, so
the encoder/decoder-to-transport seam has at least one guard that is not a
double.

### What NOT to integration test

- Encoding/decoding edge cases (unit tests)
- Error handler isolation (unit tests)
- Invalid input validation (unit tests)
