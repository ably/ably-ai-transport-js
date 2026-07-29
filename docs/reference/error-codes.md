# Error codes

AI Transport uses `Ably.ErrorInfo` as its error type. Each error has a numeric `code`, an HTTP `statusCode`, and a descriptive `message`.

## Error codes

| Code   | Name                         | Status | Description                                                                                                                                                                                                                                                                                | Recovery                                                                                                                                                                        |
| ------ | ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 40000  | `BadRequest`                 | 400    | The request was invalid                                                                                                                                                                                                                                                                    | Check the request parameters                                                                                                                                                    |
| 40003  | `InvalidArgument`            | 400    | An argument passed to a public method was invalid                                                                                                                                                                                                                                          | Fix the argument value                                                                                                                                                          |
| 40033  | `OperationCancelled`         | 400    | The operation was cancelled — the run was cancelled, the caller's abort signal fired, or the session began closing while the operation was in flight                                                                                                                                       | Expected during cancellation; retry only if the cancel was not intended                                                                                                         |
| 40160  | `InsufficientCapability`     | 401    | The Ably channel rejected a publish for a capability reason (missing publish capability)                                                                                                                                                                                                   | Grant the client publish capability on the channel                                                                                                                              |
| 50000  | `InternalError`              | 500    | An internal invariant failed — the SDK or the Ably service behaved in a way the SDK cannot recover from or explain (e.g. a publish succeeded but returned no serial)                                                                                                                       | Not caused by caller input; check connectivity and report if it persists                                                                                                        |
| 93002  | Mutable messages not enabled | 400    | The channel's namespace does not have the `mutableMessages` rule enabled, so AI Transport cannot append stream tokens. The first append fails with `Can only update/delete/append messages on channels with mutableMessages enabled`. The single most common AI Transport setup failure.   | Enable the **Message annotations, updates, deletes, and appends** rule on the namespace. See [channel rules](https://ably.com/docs/ai-transport/getting-started/channel-rules). |
| 104000 | `EncoderRecoveryFailed`      | 500    | Encoder recovery failed after flush — one or more `updateMessage` calls could not recover a failed append pipeline                                                                                                                                                                         | Non-fatal; the message may be incomplete on the channel. Check network connectivity                                                                                             |
| 104001 | `SessionSubscriptionError`   | 500    | The session's channel subscription failed — the subscribe/attach step failed, or a session-level subscription callback threw unexpectedly                                                                                                                                                  | Non-fatal when a callback threw; the session is still operational. Check error handler logic                                                                                    |
| 104002 | `CancelListenerError`        | 500    | Cancel listener or `onCancel` hook threw while processing a cancel message                                                                                                                                                                                                                 | Non-fatal; check the `onCancel` hook implementation                                                                                                                             |
| 104003 | `RunLifecycleError`          | 500    | A publish within a run failed (lifecycle event, message, or event)                                                                                                                                                                                                                         | Non-fatal; the run may not be fully visible to other clients. Check channel permissions                                                                                         |
| 104004 | `SessionClosed`              | 400    | An operation was attempted on a session, view, or encoder that has already been closed                                                                                                                                                                                                     | Create a new instance                                                                                                                                                           |
| 104005 | `SessionSendFailed`          | 500    | A send failed: the core's channel publish failed, or the Vercel chat transport's agent-invocation POST failed (network error or non-2xx)                                                                                                                                                   | Check channel publish capability, or agent availability and endpoint URL                                                                                                        |
| 104006 | `ChannelContinuityLost`      | 500    | The Ably channel lost message continuity after its initial attach (FAILED, SUSPENDED, DETACHED, or re-attached with `resumed: false`)                                                                                                                                                      | Surfaced via `session.on('error')`. Check network connectivity and channel state                                                                                                |
| 104007 | `ChannelNotReady`            | 400    | An operation was attempted but the channel is not in a usable state (not ATTACHED or ATTACHING)                                                                                                                                                                                            | Check the channel state and why it entered that state                                                                                                                           |
| 104008 | `StreamError`                | 500    | An error occurred while piping a response stream to the channel — the source event stream threw (e.g. LLM provider rate limit, model error, network failure) or an underlying publish failed mid-stream. Also the fallback code when a run-end reports an error without a code on the wire | Surfaced via the agent's `onError`; the run ends with reason `error`                                                                                                            |
| 104010 | `InputEventNotFound`         | 504    | A fresh process adopting an open run via `adoptRun().load()` waited for that run's `ai-run-start` to be observed on the channel (live + bounded history scan) but `load()`'s `timeoutMs` lapsed (or history exhausted) without seeing it                                                   | Retryable — a workflow-ordering error where the open activity's run-start has not yet propagated; retry the adopting activity. Any history-fetch failure is the `cause`         |
| 104011 | `HistoryFetchFailed`         | 500    | A `channel.history()` page fetch failed after retries while paginating history (a `loadOlder` reveal, or the agent's `run.view` drain)                                                                                                                                                     | Surfaced on the client as the view's `loadError` (and `useView`'s `loadError`); retry the load and check network connectivity                                                   |

Codes 40000, 40003, 40033, 40160, 50000, and 93002 are standard Ably error codes. Codes 104000–104999 are reserved for the AI Transport SDK (104009 is currently unused).

## Checking error codes

Use `errorInfoIs` to compare:

```typescript
import { ErrorCode, errorInfoIs } from '@ably/ai-transport';

session.on('error', (error) => {
  if (errorInfoIs(error, ErrorCode.SessionSendFailed)) {
    // A channel publish failed (or, in the Vercel chat transport, the
    // agent-invocation POST failed)
  }
  if (errorInfoIs(error, ErrorCode.SessionClosed)) {
    // Session was used after close()
  }
});
```

## Error delivery

Errors reach you through different channels depending on context:

| Context                                                                             | Delivery mechanism                                                                              |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Invalid argument to a public method                                                 | Thrown synchronously                                                                            |
| Cancellation (`run.start()`/`run.load()` on a cancelled run, aborted history load)  | The awaited operation rejects with `OperationCancelled`                                         |
| Channel publish failure (send/regenerate/edit)                                      | `send()` rejects; `session.on('error')` also fires                                              |
| Agent-invocation POST failure (Vercel chat transport)                               | The `useChat`-facing stream is errored with `SessionSendFailed` (the core run is untouched)     |
| Channel continuity loss on the client (FAILED, SUSPENDED, DETACHED, resumed: false) | Emitted via `session.on('error')`; the Vercel chat transport errors its `useChat`-facing stream |
| Channel continuity loss on the server (FAILED, SUSPENDED, DETACHED, resumed: false) | `onError` callback on `AgentSessionOptions` (in-flight runs are not auto-cancelled)             |
| Channel subscription error                                                          | Emitted via `session.on('error')`                                                               |
| Server-side run error                                                               | `onError` callback on `RunHooks`                                                                |
| Session-level error (not scoped to a run)                                           | `onError` callback on `AgentSessionOptions`                                                     |

## Error message format

All error messages follow the pattern: `"unable to <operation>; <reason>"`.

```typescript
// Examples:
// "unable to send message; session is closed"
// "unable to publish run-start; channel publish failed"
// "unable to cancel; cancel listener threw"
```
