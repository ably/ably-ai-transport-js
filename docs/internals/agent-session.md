# Agent session

The agent session (`src/core/transport/agent-session.ts`) handles the server-side run lifecycle over an Ably channel. It composes a [RunManager](transport-components.md#runmanager) for run state and lifecycle event publishing, and delegates stream piping to [pipeStream](transport-components.md#pipestream).

The session exposes a single factory method - `createRun()` - which returns a `Run` object with explicit lifecycle methods: `start()`, `addMessages()`, `pipe()`, and `end()`.

## Construction and connect

`createAgentSession()` is synchronous and does no channel I/O - it constructs the [RunManager](transport-components.md#runmanager) bound to the channel and returns. Callers must `await session.connect()` before `createRun()` or any run-lifecycle method; otherwise those methods throw `InvalidArgument`.

`connect()`:

1. Subscribes to `ai-cancel` events on the channel (subscribing before attach per [RTL7g](https://sdk.ably.com/builds/ably/specification/main/features/#RTL7g))
2. Starts routing cancel messages to registered runs

The method is idempotent - a second call returns the same in-flight promise and does not subscribe twice. The cancel subscription is the session's primary subscription. `Run.start()` may install a transient unfiltered subscription for the duration of the input-event lookup (see _Input-event lookup_ below); it unsubscribes as soon as a match is found or the deadline lapses. All other message publishing goes through the RunManager and codec encoder.

## Input-event lookup

The client publishes the user prompt(s) directly on the channel; the agent locates them by their `event-id`. The session attaches with a channel rewind (default 2 minutes, tunable via `AgentSessionOptions.rewindWindow`) so messages published before the agent attached are replayed through the session's unfiltered listener. A longer window improves the chances of finding a user prompt for an agent with a slow cold start but increases the message volume replayed on attach (and therefore the pressure on `inputEventBufferLimit`).

Inside `Run.start()`:

- If the invocation carries no `inputEventId`, the lookup is skipped — a continuation send after a tool result (the events array carries the work; no new input event was published) or a degenerate run with no client input.
- If `inputEventLookupTimeoutMs` is `0` (tests and in-process drivers that don't round-trip through the channel), the lookup is skipped.
- Otherwise the lookup waits for the single triggering `inputEventId` to arrive, matched against `event-id`. A multi-message `send([m1, m2, …])` names only its last input as the trigger; the earlier messages are read from the channel later via the run projection (`loadConversation`), not gated on by this lookup. Redeliveries of the trigger are deduped by event-id (and by Ably `serial`, since rewind may redeliver a message also seen live) before it is appended to `run.view.messages`. The lookup is bounded by the `AgentSessionOptions.inputEventLookupTimeoutMs` budget (default 30 000 ms).
- Input events may arrive before `Run.start()` runs (rewind replay on attach). The session buffers them by `event-id` (`Map<string, InboundMessage[]>`) so a later `_registerInputEventListener` call drains them on registration. The listener stays registered after the drain to also receive live arrivals until the lookup completes.
- The buffer is bounded by `AgentSessionOptions.inputEventBufferLimit` (default 200) — counted by distinct `event-id` entries, not by individual messages. When the limit is exceeded the oldest event entry (and all its buffered redeliveries) is FIFO-evicted and a warn is logged with the evicted `event-id` and the limit. The client whose input event was evicted will fail its lookup with `InputEventNotFound`, so the warn is the only operator-visible signal that capacity was the cause.
- If the trigger does not arrive before the timeout the lookup rejects with `InputEventNotFound` (its message includes the count, e.g. `"received 0 of 1"`); a decode failure mid-lookup rejects it too, wrapping the decode error as `cause`. In both cases `Run.start()` rejects without publishing `ai-run-start` **and without publishing any lifecycle event on the channel** — a phantom `ai-run-end` would violate the `run-start → run-end` lifecycle invariant for other channel observers who never saw a start. The developer's HTTP handler surfaces the failure as a non-2xx response, which the client's `send()` translates into a rejection via the HTTP-error path.

## Run lifecycle

A run progresses through a fixed sequence:

```mermaid
sequenceDiagram
    participant App as Server app
    participant Run as Run object
    participant Ch as Channel

    App->>Run: createRun(opts)
    Note right of Run: registered for cancel routing
    App->>Run: start()
    Run->>Ch: publish(ai-run-start)
    App->>Run: addMessages(inputs)
    Run->>Ch: publish(user messages via encoder)
    App->>Run: pipe(llmStream)
    Run->>Ch: publish + append (assistant response)
    App->>Run: end('complete')
    Run->>Ch: publish(ai-run-end)
```

### createRun

Synchronous - no channel activity. Creates a `Run` object and registers it under a provisional run-id immediately, so `close()` can abort an in-flight `start()`. A cancel arriving before `start()` resolves the triggering input is buffered (by that input's `codec-message-id`) and fires the run's `AbortSignal` once the input-event lookup completes.

Each run gets its own `AbortController`. If `opts.signal` is provided (typically `req.signal` from the HTTP request), `AbortSignal.any()` composes it with the controller's signal into a single composite signal. The `abortSignal` property exposes this composite signal so the server app can pass it to LLM calls. Either source - an Ably cancel message or the external signal - triggers the same downstream cancellation.

### start

Publishes the run's opening lifecycle event to the channel via the [RunManager](transport-components.md#runmanager): `ai-run-start` for a fresh run, or `ai-run-resume` when the triggering input carries a `run-id` - the agent reads it off the input wire during the input-event lookup, and a `run-id` there marks a continuation re-entering that run. The public `start()` call is the same either way - the choice is internal. Run identity is resolved here, not from the invocation body (which carries no `run-id`): the agent mints a provisional run-id at `createRun` (`runtime.runId ?? crypto.randomUUID()`), and a continuation adopts the existing `run-id` read off the triggering input, re-keying its registration to that id. It stamps the resolved `run-id` on the lifecycle event. Must be called before `pipe()`.

The lifecycle event carries `input-client-id` — the Ably-level publisher `clientId` of the input event that triggered this invocation, read from the wire by the input-event lookup. On a fresh run this typically matches `run-client-id` (the run owner). On a continuation invocation triggered by an input from a non-owner (e.g. a tool-result publish from a different client), the new `input-client-id` reflects whoever published that input while `run-client-id` stays put. See [Client identity](wire-protocol.md#client-identity).

### addMessages

Publishes user messages to the channel through the codec encoder. Each message gets:

- A generated `codec-message-id`
- [Transport headers](wire-protocol.md#transport-headers) via [buildTransportHeaders](transport-components.md#buildtransportheaders) (role, run IDs, parent, forkOf, plus `input-client-id` propagated from the triggering input event)
- Per-message headers from the client override transport-generated defaults - this lets `codec-message-id` from the client's optimistic insert pass through for [reconciliation](glossary.md#optimistic-reconciliation)

Returns the effective codec-message-ids of all published messages.

### pipe

Pipes a `ReadableStream<TOutput>` through the codec encoder to the channel via [pipeStream](transport-components.md#pipestream). The stream carries the assistant's response - text deltas, reasoning, lifecycle events.

Headers are built with `role: 'assistant'`, the run's branching metadata (parent, forkOf), and `input-client-id` propagated from the triggering input event (so every assistant output of this invocation carries the publisher's id). The `AbortSignal` from the RunManager is passed to pipeStream, so cancel signals propagate through to stream termination.

Returns `{ reason }` - `'complete'`, `'cancelled'`, or `'error'`. Does **not** call `end()` - the caller must do that after `pipe()` returns.

### end

Publishes `ai-run-end` to the channel and unregisters the run from cancel routing. The lifecycle event carries `input-client-id` matching the value stamped on `ai-run-start` for the same invocation. Idempotent - calling `end()` twice is safe.

### suspend

Publishes `ai-run-suspend` instead of `ai-run-end`, pausing the run without ending it - call this when the run is awaiting participant input (a client-side tool execution or a server-side tool approval). The run stays live so a later invocation can resume it under the same `runId`. The suspend carries the same per-invocation attribution as `end()` (`invocation-id`, `input-client-id`, `input-codec-message-id`). The run manager drops the run from cancel routing on suspend - the agent process terminates, so a cancel arriving during suspension is a no-op and the resuming invocation re-registers the run. Like `end()`, it is terminal for this Run instance (a fresh Run handles the resume) and is a no-op if the run has already ended or suspended.

## Cancel routing

The agent session handles cancel messages directly - no separate cancel manager. See [Transport components: cancel routing](transport-components.md#cancel-routing-agent-session) for the lookup and handler-isolation rules.

Key behaviors:

- Each `ai-cancel` targets exactly one run via the `run-id` header. Cancels missing that header are dropped with a warn-level log.
- Runs are registered for cancel routing on `createRun()`, before `start()`. Early cancels fire the run's `AbortSignal`.
- The `onCancel` hook (per-run) can return `false` to reject a cancel request.
- A throwing `onCancel` handler is wrapped into an `Ably.ErrorInfo` and surfaced via the run's `onError` (falling back to the session-level `onError`). The throw does not propagate out of the listener.

## Channel continuity

The agent session monitors the channel for continuity loss after the initial attach. Continuity is lost when the channel enters FAILED, SUSPENDED, or DETACHED, or re-attaches with `resumed: false`. On loss, the session invokes the session-level `onError` callback with `ChannelContinuityLost` (104006).

Unlike the [client session's handling](client-session.md#delivery-guarantee), the agent does not cancel in-flight runs or fan out to per-run `onError`. The agent only consumes cancel messages from the channel, so losing one is survivable; the signal is observability so developers can choose whether to terminate in-flight work themselves (e.g. by aborting their external signals). Per-run `onError` remains scoped to that run's own operations.

## Close

`close()` unsubscribes from cancel messages, stops listening for channel state changes, cancels all active runs (via their `AbortController`s), clears the registration map, and detaches the channel the session attached (best-effort — a detach failure is swallowed). It returns a promise that resolves once the detach completes, so a serverless agent can `await session.close()` for a graceful teardown before the function returns. It does **not** close the injected Ably client — the caller owns its lifecycle. It is idempotent. After close, existing Run objects can still call `end()` (to publish run-end) but new runs cannot be created.

## Error handling

Errors fall into two categories:

| Scope         | Delivery                      | Examples                                                                                           |
| ------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Session-level | `options.onError` callback    | Cancel subscription failure, channel attach error, channel continuity loss (FAILED/SUSPENDED/etc.) |
| Run-level     | `runOptions.onError` callback | Run-start publish failure, stream encoding error                                                   |

Run-level errors fall back to the session-level `onError` if no per-run handler is provided. Channel-wide events (e.g. continuity loss) always go to the session-level `onError` and are not replicated to per-run handlers.

### Surfacing errors on the channel

There is no dedicated transport-level error event. Failures reach observers (and the originating client) through one of two paths, depending on whether `ai-run-start` was published:

| Failure point                                         | Wire surface                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Before `ai-run-start`** (e.g. `InputEventNotFound`) | No channel publish. `Run.start()` rejects; the developer's HTTP handler surfaces the failure as a non-2xx response, which the client's `send()` translates into a rejection. Publishing a phantom `ai-run-end` would break the `run-start → run-end` lifecycle invariant. |
| **Mid-run** (after `ai-run-start`)                    | `ai-run-end` published with `run-reason: error` and the `error-code` / `error-message` headers. The client reifies an `Ably.ErrorInfo` from the headers, errors the active stream, and emits `session.on('error')`.                                                       |

See [Transport components](transport-components.md) for the RunManager, pipeStream, and cancel routing internals. See [Client session](client-session.md) for the client-side counterpart. See [Wire protocol](wire-protocol.md) for the header and event specification.
