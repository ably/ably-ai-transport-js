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
determinism on replay. Activity bodies are faked, so this tier needs no Ably
credentials and touches no channel. Their behaviour is covered twice elsewhere:
against mocks in the unit tier, and against a real channel in
`test/integration/temporal/`, which boots its own Temporal server inside the
integration tier rather than adding a fourth one here.

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
- **Integration level**: drive a host framework's own runtime over a real channel. `test/integration/temporal/` boots a Temporal server and registers the real plugin, so the framing activities publish from inside real activities. This is the only level where a framework's scheduling and the platform's wire meet.

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

### Where the tier lives

Every integration test sits under `test/integration/`, in a subdirectory
mirroring the part of `src/` it exercises: `test/integration/core/` for the
codec-agnostic transports and `test/integration/vercel/` for the Vercel codec,
its chat-transport adapter, and the useChat wiring. Both vitest configs select
the tier by filename (`*.integration.test.ts`), so a new subdirectory needs no
config change.

### What every test in the tier owes

Each one has three jobs, and they matter equally: exercise only the public API
(what an `index.ts` re-exports, never a private field), read as the code a
developer would write to get the behaviour, and fail when the behaviour breaks.
The second one constrains how a test is written. The API calls stay in the body
of the test, and helpers cover only what a developer does not write themselves:
a channel name, a fixture output stream, and waiting for an event. A local
helper that wraps a sequence of API calls hides the thing the test exists to
show.

### What the tier covers today

**Codec level**, in `test/integration/vercel/wire-codec.integration.test.ts`: a
text and tool-call roundtrip over a real channel, proving the wire format and
Ably's message serialization.

**Transport level**, in `test/integration/core/transport.integration.test.ts`:
a whole turn from send to reply, a cancel that aborts a streaming run, steering
with both its promises settling, a client observing a run another participant
started, a tool call resolving through the transport, steering settling for a
client running with `echoMessages: false`, sequential and concurrent runs,
backwards history paging, the attach boundary, error propagation, and durable
cross-process re-entry through `adoptRun`.

**Adapter level**, in `test/integration/vercel/chat-transport.integration.test.ts`:
a send streaming its reply, a foreign run reaching an idle client and a busy
one, a regenerate, an edit waking a fresh run, a refresh resuming an in-flight
run from its store's serial, a superseded step attempt erroring the stream and
its repair, reading a finished conversation out of history, and withholding an
in-flight run for a resume. Failures reaching useChat's status and `onError`
live beside it in `use-chat-error-propagation.integration.test.ts`, the one
integration file that mounts a real `useChat`.

**Integration level**, in `test/integration/temporal/temporal.integration.test.ts`:
a whole durable turn pinned to its invocation id, a terminal published from
workflow code across three processes, a Temporal retry superseding its dead
attempt's step, one invocation id opening twice into a single run with one
`ai-run-start`, the cleanup arm closing a failed turn, the same arm surviving a
workflow cancel, an end published twice landing once, and the cleanup arm's
terminal dropped over a run the activity already ended. The last three rest on
the idempotent message ids the run manager stamps on `ai-run-start` and
`ai-run-end`, and each reads channel history as the proof that a duplicate was
dropped rather than late.

That file owns three constraints the other areas do not. It uses
`TestWorkflowEnvironment.createLocal()` rather than `createTimeSkipping()`,
because its activities do real network I/O and a server free to fast-forward
its clock could fire `startToCloseTimeout` mid-request; a consequence is that a
`sleep()` in a fixture really sleeps, so no fixture waits one out. It shares one
server, one webpack bundle and one long-lived worker across the file rather than
calling `worker.runUntil` per test, because a worker shutdown cancels in-flight
activities and these hold real Ably clients. And its `beforeAll` carries its own
120s timeout for the server boot and the bundle.

It also brings its own codec. `test/integration/temporal/test-codec.ts` carries
one input kind and one text-stream output group, so nothing on screen belongs to
a provider — a borrowed codec would put its framing events and its reducer
between the reader and the subject. It is a real codec built with `defineCodec`,
not a hand-rolled `WireCodec`, because the `stream(...)` descriptor is what makes
the SDK's own encoder core produce the create-append-close sequence this tier
exists to exercise. Its `assembleText` checks the stream brackets while joining,
which is the well-formedness proof a provider's reducer used to give for free.

Its fixture workflows are linted by the same rule that guards
`src/temporal/workflow/`: the bundler strips types per file with no type
information, so a value import of something that happens to be a type drags
`ably` into the sandbox bundle.

The tests that hold a run open across a refresh or a cancel share two rules
worth stating once. A route that means to leave its run in flight does not
await its `pipe`, and whatever finishes that run later must await the pipe
before publishing the terminal, because ending a run while its pipe is still
flushing cuts the rest of the reply off the wire. And a test waiting for a
partial reply waits for a `text-delta` rather than any output event: a streamed
message opens on its first delivery and its text arrives on a later append.

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
- **A real durable-execution retry.** One `activityId` across attempts, and the
  `stepId` supersede that follows from it, exist only when Temporal itself
  schedules the retry. A faked retry re-implements the rule it is testing.

`test/core/transport/codec-transport.test.ts` is the unit test that composes a
real codec with both real transports against a mock channel, so the
encoder/decoder-to-transport seam is guarded in the fast tier as well.

### What NOT to integration test

- Encoding/decoding edge cases (unit tests)
- Error handler isolation (unit tests)
- Invalid input validation (unit tests)
- React hook lifecycle (unit tests with jsdom)
