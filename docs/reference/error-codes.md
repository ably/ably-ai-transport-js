# Error codes

AI Transport uses `Ably.ErrorInfo` as its error type. Each error has a numeric `code`, an HTTP `statusCode`, and a descriptive `message`.

## Error codes

| Code | Name | Status | Description | Recovery |
|---|---|---|---|---|
| 40000 | `BadRequest` | 400 | The request was invalid | Check the request parameters |
| 40003 | `InvalidArgument` | 400 | An argument passed to a public method was invalid | Fix the argument value |
| 104000 | `EncoderRecoveryFailed` | 500 | Encoder recovery failed after flush - `updateMessage()` could not recover a failed append pipeline | Non-fatal; the message may be incomplete on the channel. Check network connectivity |
| 104001 | `TransportSubscriptionError` | 500 | A channel subscription callback threw unexpectedly | Non-fatal; the transport is still operational. Check error handler logic |
| 104002 | `CancelListenerError` | 500 | Cancel listener or `onCancel` hook threw while processing a cancel message | Non-fatal; check the `onCancel` hook implementation |
| 104003 | `TurnLifecycleError` | 500 | A turn lifecycle event (turn-start or turn-end) failed to publish | Non-fatal; the turn may not be visible to other clients. Check channel permissions |
| 104004 | `TransportClosed` | 400 | An operation was attempted on a closed transport | Create a new transport instance |
| 104005 | `TransportSendFailed` | 500 | The HTTP POST to the server endpoint failed (network error or non-2xx response) | Check server availability and endpoint URL |

Codes 40000 and 40003 are standard Ably error codes. Codes 104000–104005 are specific to the AI Transport SDK.

## Checking error codes

Use `errorInfoIs` to compare:

```typescript
import { ErrorCode, errorInfoIs } from '@ably/ai-transport';

transport.on('error', (error) => {
  if (errorInfoIs(error, ErrorCode.TransportSendFailed)) {
    // The HTTP POST to the server failed
  }
  if (errorInfoIs(error, ErrorCode.TransportClosed)) {
    // Transport was used after close()
  }
});
```

## Error delivery

Errors reach you through different channels depending on context:

| Context | Delivery mechanism |
|---|---|
| Invalid argument to a public method | Thrown synchronously |
| HTTP POST failure (send/regenerate/edit) | Emitted via `transport.on('error')` |
| Channel subscription error | Emitted via `transport.on('error')` |
| Server-side turn error | `onError` callback on `NewTurnOptions` |
| Transport-level error (not scoped to a turn) | `onError` callback on `ServerTransportOptions` |

## Error message format

All error messages follow the pattern: `"unable to <operation>; <reason>"`.

```typescript
// Examples:
// "unable to send message; transport is closed"
// "unable to publish turn-start; channel publish failed"
// "unable to cancel; cancel listener threw"
```
