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

- Mock the channel rather than the Ably SDK; shared mocks live in `test/helper/`. `test/helper/mock-channel.ts` is the channel an adaptor writes to: it records publishes, appends and updates. A decoder takes messages, not a channel, so a decoder test hands it fixture messages directly. `test/helper/test-codec.ts` is a `defineCodec` codec that belongs to no provider.
- A codec suite round-trips through `test/helper/wire.ts`, which turns what the codec encoded into the inbound messages a subscriber would receive, with the serial bookkeeping the pipe writer does on a real channel, and decodes them back through a fresh decoder core on each call, since a codec holds no state of its own.
- `flushMicrotasks()` or a `setImmediate` hop instead of `setTimeout`; never a clock in a test.
- For streams that stay open, simulate a terminal event to close deterministically, then drain the reader.

### What to unit test

- All code paths in every module: success, error, edge cases
- Error handler isolation (one throwing handler doesn't kill others)
- State transitions: the per-pipe key table, the append chain and its repair, the decoder core's version guard and the state it frees when a stream ends
- Invalid input validation

## Integration tests

### Scope

Prove the system works over real Ably. Don't duplicate unit-test edge cases. Each test exercises a user-visible scenario end-to-end. Use fixture event streams (deterministic, no LLM calls needed).

Integration tests are written at two levels:

- **Codec level** (`test/integration/vercel/`, `test/integration/openai/`, `test/integration/ag-ui/`): a provider's fixture stream piped through an adaptor over that codec and decoded by a decoder subscribed to a real channel. Where the provider has a reducer, the decoded sequence is folded with it, which is the proof the wire is one the provider accepts.
- **Adaptor and decoder level** (`test/integration/core/`): send, both pipes, live and late subscription, history, foreign messages and repair over a real channel, with the test codec so nothing on screen belongs to a provider.

### Environment

By default, integration tests run against the **Ably sandbox**. The globalSetup (`test/helper/test-setup.ts`) provisions a temporary app via the sandbox REST API; no API key or secrets are needed.

To run against a different environment, set `VITE_ABLY_ENV`:

| `VITE_ABLY_ENV`       | Behaviour                                      | API key required?            |
| --------------------- | ---------------------------------------------- | ---------------------------- |
| _(unset)_ / `sandbox` | Provisions a sandbox app automatically         | No                           |
| `local`               | Connects to `local-rest.ably.io:8081` (no TLS) | Yes, set `VITE_ABLY_API_KEY` |
| `production`          | Connects to production Ably                    | Yes, set `VITE_ABLY_API_KEY` |

Independently, setting `ABLY_LOCAL_SANDBOX_URL` (e.g. `http://localhost:9010`) points app provisioning at a **local sandbox**, a provisioner fronting a local Ably-compatible server, instead of the cloud. The globalSetup provisions the app through that sandbox's `POST /apps`, and clients route at the isolated server it reports (its own endpoint/port/tls). This is the inert support the ably-server compatibility harness drives; it takes precedence over `VITE_ABLY_ENV` and is a no-op (cloud path unchanged) when unset.

### Conventions

- Unique channel names per test via `uniqueChannelName()` to avoid crosstalk
- A test gets each channel from `ablyRealtimeClient().channels.get(name)`, as an application does, and subscribes a decoder with `channel.subscribe(decoder.receive)`; awaiting that subscribe is the attach barrier.
- Clean up clients in `afterEach` via `closeAllClients()`
- Shared unit-tier helpers live in `test/helper/`; the integration tier's own recorder and history drain live in `test/integration/helpers.ts`
- **Await events, never clocks.** `createDeliveryRecorder()` buffers every delivery as it arrives and re-checks pending predicates on each one, so a test awaits the delivery it needs instead of polling a growing array. Recorders take no timeout: vitest's own test timeout is the only deadline, and a test that hangs is a test that found something.
- A test waiting for a partial reply waits for a delta rather than any delivery: a stream's start event is its own message, and its text arrives on the deltas' message, which the first delta opens.
- History needs no retry: `untilAttach` bounds it at the attach point, and a channel attached after the pipe finished reads what the platform has persisted.

### What every test in the tier owes

Each one has three jobs, and they matter equally: exercise only the public API (what an `index.ts` re-exports, never a private field), read as the code a developer would write to get the behaviour, and fail when the behaviour breaks. The second one constrains how a test is written. The API calls stay in the body of the test, and helpers cover only what a developer does not write themselves: a channel name, a fixture stream, and waiting for a delivery. A local helper that wraps a sequence of API calls hides the thing the test exists to show.

### What the tier covers today

**Adaptor and decoder**, in `test/integration/core/adaptor-decoder.integration.test.ts`: a reply piped through `pipeEach` and decoded by `channel.subscribe(decoder.receive)` with the serial each event landed on, a decoder subscribing mid-stream, history paged back and fed newest first through `decode()`, the application's own publish and another codec's delivered with no event, a failed append repaired by one update, a pipe aborted by its signal, a delete delivered with no event, and a client that joins mid-reply by rewinding to the prompt's serial and decodes the reply whole and in order. Each provider suite also pipes through its provider adaptor and decodes through its provider decoder.

**Codec level**, in `test/integration/vercel/wire-codec.integration.test.ts`, `test/integration/openai/wire-codec.integration.test.ts` and `test/integration/ag-ui/wire-codec.integration.test.ts`: a tool-calling turn streamed event for event and folded by the AI SDK's own reducer, a user message under the serial `send` returned, a finished turn read from history as the events the agent produced with each stream's deltas joined into one, a transient data part flagged ephemeral on delivery, the two Responses of a function call round-tripped with the call's output published as input, and an AG-UI run's text, tool-call and chunk streams merged by AG-UI's own reducer from live deliveries and from history into the same messages, with a messages snapshot kept off the channel.

Rather than list the scenarios here (the suite's own `it` titles are the authoritative list), this is what the tier is _for_, and what a new scenario should need to earn a place in it:

- **Message appends.** The streaming wire is one message updated in place, and a mock channel cannot reproduce the platform's append semantics.
- **The append rollup.** Ably delivers the appends a connection publishes within a window (40ms by default) as one message with the data joined and only the last extras, and a publish sent while a delta is held can reach subscribers first. The suites' clients set the publishing client's `appendRollupWindow` transport param to 0 (`test/helper/realtime-client.ts`), so a test asserts one delivery per append; a scenario about the rollup itself would create its client with the default window.
- **The first post-attach append**, which the platform converts into a full-content update. That conversion is what the decoder core's tail reduction exists for.
- **`untilAttach` paging and serial allocation.** Both the attach boundary and every serial an ack reports come from the platform.
- **The ephemeral flag.** Whether `extras.ephemeral` is echoed on delivery is the platform's to decide.

`test/core/adaptor/agent-adaptor.test.ts` composes the real test codec with the real adaptor against the mock channel, and `test/core/decoder/decoder.test.ts` decodes what the test codec encoded, so both codec boundaries are guarded in the fast tier as well.

### What NOT to integration test

- Encoding/decoding edge cases (unit tests)
- Error handler isolation (unit tests)
- Invalid input validation (unit tests)
- Whether an ephemeral message reaches history. The sandbox serves recent messages from memory and an ephemeral one can appear there, so the assertion is not stable.
