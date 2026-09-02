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

Every exported function and every non-trivial internal module gets its own test file. Tests live under `test/`, mirroring the `src/` layout. Aim for 90%+ line coverage on non-React code, 80%+ on React hooks.

### Style

- Mock the channel and the codec encoder rather than the Ably SDK; shared mocks live in `test/helper/`
- `flushMicrotasks()` instead of `setTimeout` — never use timeouts in tests
- For streams that stay open, simulate a terminal event (`finish`) to close deterministically, then drain the reader

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
- Stand a transport pair up with `createAgentEndpoint()` / `createClientEndpoint()`
  from `test/helper/transport-pair.ts`; they register for `closeAllTransports()`,
  which runs alongside `closeAllClients()` in `afterEach`
- Await events, never clocks: `recordEvents()` from
  `test/helper/transport-events.ts` buffers from the moment an endpoint exists
  and resolves on a predicate. Helpers take no timeout — the 30s test timeout
  is the only deadline

### What the tier covers today

**Codec level**, in `test/vercel/codec/wire-codec.integration.test.ts`: a text
and tool-call roundtrip over a real channel, proving the wire format and Ably's
message serialization.

**Transport level**, in `test/core/transport/transport.integration.test.ts` and
`test/core/transport/transport-history.integration.test.ts`: three scenarios a
mock channel cannot stand in for.

1. **Send → stream → receive.** A client publishes an input, the agent opens a
   run naming it and streams a response, and the client's event stream carries
   the optimistic echo, the wire echo, the run and step brackets, and the
   streamed output — plus the run-id the client learns from the `ai-run-start`
   its own input triggered.
2. **History paging.** A fresh client pages backwards from its attach point
   and receives chronological batches of classified events, each call
   returning a strictly older slice, with a completed stream merged into one
   message's worth of output. Messages published after the attach point stay
   outside the window.
3. **Attach boundary.** A run streaming across a client's attach point yields
   one message's worth of events. The live merge and the history walk share a
   decoder, so the accumulated prefix is delivered once, not twice — the
   spanning message, when the window includes it, comes back from history
   carrying its metadata and no events.

These three need real Ably: message appends, the platform's conversion of the
first post-attach append into a full-contents update, `untilAttach` paging and
serial allocation have no mock equivalent.

Seven scenarios are outstanding. Each rests on the unit tier alone and is
untested over real Ably:

1. Tool call through the transport
2. Cancel chain: client cancel → agent abort → stream closes
3. Multi-run sequential, and concurrent runs
4. Steering: a steer lands on an open run and its outcome resolves
5. Durable cross-process re-entry: a second transport adopts an open run and ends it
6. Error propagation: agent error mid-stream, client observes the run's error terminal
7. Multi-client sync: two clients on the same channel both see the streamed response

`test/core/transport/codec-transport.test.ts` is the unit test that composes a
real codec with both real transports against a mock channel, so the
encoder/decoder-to-transport seam is guarded in the fast tier as well.

### What NOT to integration test

- Encoding/decoding edge cases (unit tests)
- Error handler isolation (unit tests)
- Invalid input validation (unit tests)
- React hook lifecycle (unit tests with jsdom)
