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

One exception: the React surface is tested per _surface_, not per module. A provider and the hooks that read from it only mean anything together — a hook test needs the provider mounted around it — so `test/react/` holds one suite per provider-and-its-hooks rather than one per file.

### Style

- Mock the channel and the codec encoder rather than the Ably SDK; shared mocks live in `test/helper/`
- `flushMicrotasks()` instead of `setTimeout` — never use timeouts in tests
- React suites select jsdom per file with a `// @vitest-environment jsdom`
  docblock and drive components through `@testing-library/react`; the vitest
  config carries no environment setting
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
- Shared unit-tier helpers live in `test/helper/`; the transport tier's own
  fixtures and waiting primitives live in `test/integration/helpers.ts`
- **Await events, never clocks.** `createEventRecorder()` buffers every
  classified event as it arrives and re-checks pending predicates on each one,
  so a test awaits the event it needs instead of polling a growing array.
  Recorders take no timeout — vitest's own test timeout is the only deadline,
  and a test that hangs is a test that found something.
- A helper that reads channel history (`locateInput`, `history()`) needs no
  retry: the trigger is published before the agent attaches, and the scan is
  bounded at the attach point, so the platform has persisted it by then.

### What the tier covers today

**Codec level**, one suite per codec (`test/vercel/codec/` and
`test/openai/codec/`, both named `wire-codec.integration.test.ts`): a text and
tool-call roundtrip over a real channel, proving the wire format and Ably's
message serialization.

**Transport level**, in `test/integration/transport.integration.test.ts`:
send-and-stream, a tool call resolving through the transport, the cancel chain,
steering settling for a client running with `echoMessages: false`, sequential
and concurrent runs, backwards history paging, the attach boundary, error
propagation, multi-client sync, and durable cross-process re-entry through
`adoptRun`.

Rather than list the scenarios here — the suite's own `it` titles are the
authoritative list — this is what the tier is _for_, and what a new scenario
should need to earn a place in it:

- **Message appends.** The streaming wire is one message updated in place, and
  a mock channel cannot reproduce the platform's append semantics.
- **The first post-attach append**, which the platform converts into a
  full-contents update. That conversion is what the decoder's mid-stream-join
  repair exists for.
- **`untilAttach` paging and serial allocation.** Both the attach boundary and
  every serial a terminal reports come from the platform.
- **`echoMessages: false`.** A client that never receives its own publish can
  only settle a steer from the publish acknowledgement, which needs a real ack.

`test/core/transport/codec-transport.test.ts` is the unit test that composes a
real codec with both real transports against a mock channel, so the
encoder/decoder-to-transport seam is guarded in the fast tier as well.

### What NOT to integration test

- Encoding/decoding edge cases (unit tests)
- Error handler isolation (unit tests)
- Invalid input validation (unit tests)
- React hook lifecycle (unit tests with jsdom)
