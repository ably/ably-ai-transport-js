# Error codes

AI Transport uses `Ably.ErrorInfo` as its error type. Each error has a numeric `code`, an HTTP `statusCode`, and a descriptive `message`.

## Error codes

| Code   | Name                       | Status | Description                                                                                                                              | Recovery                                                                            |
| ------ | -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 40000  | `BadRequest`               | 400    | The request was invalid                                                                                                                  | Check the request parameters                                                        |
| 40003  | `InvalidArgument`          | 400    | An argument passed to a public method was invalid                                                                                        | Fix the argument value                                                              |
| 104000 | `EncoderRecoveryFailed`    | 500    | Encoder recovery failed after flush - `updateMessage` could not recover a failed append pipeline                                         | Non-fatal; the message may be incomplete on the channel. Check network connectivity |
| 104001 | `SessionSubscriptionError` | 500    | A channel subscription callback threw unexpectedly                                                                                       | Non-fatal; the session is still operational. Check error handler logic              |
| 104002 | `CancelListenerError`      | 500    | Cancel listener or `onCancel` hook threw while processing a cancel message                                                               | Non-fatal; check the `onCancel` hook implementation                                 |
| 104003 | `RunLifecycleError`        | 500    | A run lifecycle event (run-start, run-suspend, or run-end) failed to publish                                                             | Non-fatal; the run may not be visible to other clients. Check channel permissions   |
| 104004 | `SessionClosed`            | 400    | An operation was attempted on a closed session                                                                                           | Create a new session instance                                                       |
| 104005 | `SessionSendFailed`        | 500    | A send failed: the core's channel publish failed, or the Vercel chat transport's agent-invocation POST failed (network error or non-2xx) | Check channel publish capability, or agent availability and endpoint URL            |
| 104006 | `ChannelContinuityLost`    | 500    | The Ably channel lost message continuity (FAILED, SUSPENDED, DETACHED, or re-attached with `resumed: false`)                             | Surfaced via `session.on('error')`. Check network connectivity and channel state    |

| 104007 | `ChannelNotReady` | 400 | An operation was attempted but the channel is not ATTACHED or ATTACHING | Check the channel state and why it entered that state |

Codes 40000 and 40003 are standard Ably error codes. Codes 104000–104007 are specific to the AI Transport SDK.

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
| Channel publish failure (send/regenerate/edit)                                      | `send()` rejects; `session.on('error')` also fires                                              |
| Agent-invocation POST failure (Vercel chat transport)                               | The `useChat`-facing stream is errored with `SessionSendFailed` (the core run is untouched)     |
| Channel continuity loss on the client (FAILED, SUSPENDED, DETACHED, resumed: false) | Emitted via `session.on('error')`; the Vercel chat transport errors its `useChat`-facing stream |
| Channel continuity loss on the server (FAILED, SUSPENDED, DETACHED, resumed: false) | `onError` callback on `AgentSessionOptions` (in-flight runs are not auto-cancelled)             |
| Channel subscription error                                                          | Emitted via `session.on('error')`                                                               |
| Server-side run error                                                               | `onError` callback on `RunRuntime`                                                              |
| Session-level error (not scoped to a run)                                           | `onError` callback on `AgentSessionOptions`                                                     |

## Error message format

All error messages follow the pattern: `"unable to <operation>; <reason>"`.

```typescript
// Examples:
// "unable to send message; session is closed"
// "unable to publish run-start; channel publish failed"
// "unable to cancel; cancel listener threw"
```
