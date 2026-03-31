# Initial review of AIT SDK transport

Reviewed against commit `feee499` (_transport: split into client/ and server/ subdirectories_). Line numbers refer to commit `c7587b6`, which adds the review comments on top of `feee499`.

## How this was created

This is largely a Claude-generated document. Here's how it was created.

I left inline comments throughout the transport code (i.e. that in `src/core/transport`) whilst reviewing it. Some reflected gaps in my own understanding; Claude categorised and split those out, and they're not included here. The rest — things that looked like genuine issues — are collected here. I used Claude to flesh them out with code references and assign priorities. Claude then verified each claim against the source code (not just taken from my notes at face value). That said, I may be missing context on some design decisions, so take the suggestions accordingly.

Sections are ordered by priority: public API correctness first, then behavioural questions, then implementation quality, then test quality. Items within each section are also ordered by priority (high → low).

## Depth of review

(Written by me.)

This was my first exposure to the transport code, and there's a _lot_ of it. I read through all of the code in `src/core/transport` and the corresponding tests, as well as all of the docs in `docs`. That said, reading is quite different to understanding, and whilst my level of understanding of the SDK is now a lot higher than it was when I started, I'm definitely not yet at a point where I could say with confidence "yes, all of the code that I reviewed is behaving as it should"; the tests that I reviewed seem to be testing key responsibilities of the SDK, and I'm pleased to see that the server transport integration tests make use of a client transport to give us further confidence that they work together, but I don't yet have enough of an overall mental picture of all of the SDK's responsibilities and how those are distributed between the components to be able to, say, identify test coverage gaps.

## 1. Public API

### `PaginatedMessages` exposes transport-internal fields as parallel arrays — medium

`client/types.ts:104–108`

`PaginatedMessages` has three parallel arrays (`items`, `itemHeaders`, `itemSerials`) that are fragile and easy to misalign. `itemHeaders` and `itemSerials` are only consumed by the transport itself (in `decode-history.ts` and `client-transport.ts`) — they shouldn't be on the public interface. A single array of `{ message, headers?, serial? }` objects with the transport-only fields kept internal would be both safer and a smaller API surface.

### `CancelFilter` relies on convention for mutual exclusivity — low

`types.ts:17`

`CancelFilter` is an interface with four optional fields where "at most one should be set" by convention. A discriminated union would make this compiler-enforced.

### Stream errors don't propagate error details to the client — medium

`pipe-stream.ts:83`

When `pipeStream` catches a stream error, the client only learns the turn ended with reason `'error'` but gets no information about what went wrong. For use cases like rate limit errors from the model provider, the client may need to distinguish error types to decide on retry strategy.

### Default `api` path of `"/api/chat"` is too specific for the generic transport — low

`client/types.ts:26`

This default makes sense for the chat-flavoured transport but not for a generic `ClientTransport`. If this is a general-purpose building block, the default should either be removed or documented as chat-specific.

## 2. Behavioural questions

### `addMessages()` doesn't call `onError` on failure — high

`server-transport.ts:374`

`start()` calls the turn-level `onError` callback when publish fails, and `end()` does too. But `addMessages()` just throws without invoking it. A consumer relying on `onError` for observability would miss publish failures here.

### Turn-level `onError` is documented as non-fatal but `start()` throws after calling it — medium

`server/types.ts:123`, `server-transport.ts:318–320`

The `onError` callback is documented as "Called with non-fatal transport-level errors scoped to this turn" (`server/types.ts:123`). But in `Turn.start()`, after calling `onError`, the code throws — making the error fatal. A consumer who treats `onError` as non-fatal (logging and continuing) will then also get an unhandled exception. Either the documentation should be corrected or `start()` should not throw after calling `onError`.

## 3. Implementation quality

### Map Ably message headers to typed events earlier in the pipeline — medium

`client-transport.ts:195`

Turn-start/end events are processed by ad-hoc extraction from a generic `headers` dictionary with scattered fallback defaults (empty string for missing client ID, `'complete'` as default reason). The public API already emits typed `TurnLifecycleEvent` objects, so this doesn't affect consumers — but centralising the header-to-typed-event mapping would make the expected headers per event type explicit and consolidate default-value logic.

### Turn lifecycle should use named states — medium

`server-transport.ts:305`

Currently tracked by two boolean flags (`started`, `ended`). An explicit state enum (`INITIALIZED → STARTED → ENDED`) would prevent invalid transitions and make the code self-documenting. This is consistent with how Ably's other SDKs model lifecycle.

### `_registeredTurns` and `_activeTurns` overlap — medium

`server-transport.ts:69–71`, `turn-manager.ts:59`

Both maps store the same `AbortController` and `clientId` for the same turns. The timing difference (registered at `newTurn`, active at `start`) justifies two distinct lifecycle phases, but the data duplication is real. `close()` in both classes independently aborts the same controllers (`server-transport.ts:116–125`, `turn-manager.ts:129–135`). Worth considering whether the turn manager should be the single owner of controller state.

### Minor items

- **`TurnEntry` doesn't need to be in `types.ts`** (low) — `client/types.ts:214`. It's only used by the stream router and could live in that file.
- **`TurnManager.startTurn` creates an internal controller that `ServerTransport` never uses** (low) — `turn-manager.ts:67`. `ServerTransport` always passes an external controller, and never calls `TurnManager.abort()`. The internal-controller path is dead code from the transport's perspective.
- **`_resolveFilter` and cancel-header parsing could be extracted** (low) — `server-transport.ts:138`, `server-transport.ts:158`. Both are self-contained and only read `_registeredTurns`.
- **`crypto.randomUUID()` called even when the ID is overridden** (low) — `server-transport.ts:345`. A UUID is generated for every message unconditionally, but discarded if the caller provides one in headers. Obscures intent more than it wastes cycles.
- **`_withheldKeys` comment doesn't say what the elements are** (low) — `client-transport.ts:116`. The comment says "withheld messages hidden from getMessages()" but the set contains domain message keys from the codec, not message objects or Ably message IDs. Something like `// History pagination: codec message keys of messages hidden from getMessages() until next() is called` would save the next reader a dig.

## 4. Test quality

### Weak assertions

- **Cancel test makes no assertions about the published message** (high) — `client-transport.test.ts:1548`. Only asserts `channel.publish` was called, not what was published. Should verify the cancel filter headers.
- **`waitForTurn` default test doesn't actually test the default** (medium) — `client-transport.test.ts:1699`. Only has own turns in the setup, so it would pass even if the default were `{ all: true }`. Needs an observer turn to be meaningful.
- **Cancel filter test doesn't verify observer turns are excluded** (medium) — `client-transport.test.ts:2255`. Only has own turns. A separate test covers observer turns, but this test's name claims to test the `{ own: true }` boundary and doesn't.
- **Test assertion doesn't match test name** (low) — `client-transport.test.ts:1125`. `'captures observer headers from streamed events'` only asserts `messageHandler` was called. Either the assertion or the name is wrong.

### Missing coverage

- **Missing `cancelled` / `error` reason tests for `streamResponse`** (medium) — `server-transport.test.ts:313`. Only the `'complete'` path is tested.
- **Missing test that `streamResponse` passes events to the codec** (medium) — `server-transport.test.ts:310`. Noted as a TODO.

### `setTimeout` in tests violates project conventions

`pipe-stream.test.ts:137`, `server-transport.integration.test.ts:240`

TESTS.md says "`flushMicrotasks()` instead of `setTimeout` — never use timeouts in tests". Several tests use `setTimeout` with arbitrary delays (10ms, 500ms). The integration test at line 240 is explicitly timing-based.

### To investigate

- **Does `controller.error(...)` match how Vercel AI SDK surfaces errors?** — `server-transport.integration.test.ts:413`. Worth verifying the test's error injection matches real provider behaviour.

### Minor test hygiene

- **Test comment references line 283** — `client-transport.test.ts:1095`. Will go stale; should describe behaviour instead.
- **Integration test comment overstates what's asserted** — `client-transport.integration.test.ts:588`. Says "should include turn-start, encoded messages, and turn-end" but only start/end are asserted.
- **`noopFetch` cast is repeated 8 times without comment** — `client-transport.integration.test.ts`. TYPES.md requires every `as` cast to have a comment explaining why. Could be centralised into a test helper.
- **Missing assertion that `startTurn` adds to active turns** — `turn-manager.test.ts:108`. Only asserts removal on end.
- **Missing assertion that active turn count returns to zero** — `client-transport.integration.test.ts:325`. Asserts `> 0` before but not `0` after.
