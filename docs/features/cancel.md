# Cancel

Cancellation in AI Transport is a channel-level operation - the client publishes a cancel signal on the Ably channel, the server receives it and cancels the targeted run.

Without a cancel protocol, stopping a generation requires either dropping the HTTP connection (which the server may not notice) or building custom signaling. AI Transport handles the full cancel chain: client signal, server-side cancellation, stream cleanup, and lifecycle notification to all clients.

## Client side

Cancel a specific run by ID:

```typescript
// Cancel a specific run (returned by send/regenerate/edit). This is the
// preferred form: run.cancel() keys on the input's codec-message-id, which the
// client owns synchronously, so a cancel issued before the agent has minted the
// run id is still honoured (the agent buffers it until its run is known).
const run = await view.send(UIMessageCodec.createUserMessage(message));
await run.cancel();

// Or cancel by runId from anywhere that holds the id. The agent mints the run
// id now, so await run.started to learn it, then read run.runId (run.cancel()
// avoids this wait).
await run.started;
await session.cancel(run.runId);
```

Each `session.cancel(runId)` call targets exactly one run. To cancel multiple runs, iterate over runIds you hold yourself (await each `send()` handle's `started`, then read its `runId`).

In React, the simplest "stop" button keeps the most recent `ClientRun` returned by `send` and calls `run.cancel()` on it. Because `run.cancel()` keys on the input's codec-message-id, it works the instant the send is published — no need to await `run.started`:

```typescript
import { useState } from 'react';
import { useView } from '@ably/ai-transport/react';
import type { ClientRun } from '@ably/ai-transport';

const { send } = useView({ session });
const [activeRun, setActiveRun] = useState<ClientRun | undefined>();

const onSend = async (message: AI.UIMessage) => {
  const run = await send(UIMessageCodec.createUserMessage(message));
  setActiveRun(run);
};

<button
  onClick={() => {
    void activeRun?.cancel();
  }}
  disabled={!activeRun}
>
  Stop
</button>
```

This stops the only thing the user can meaningfully stop — the response to the send they just made — without waiting on the agent to mint the run-id.

## Server side

Each run has an `AbortSignal` that fires when a matching cancel arrives:

```typescript
import { Invocation } from '@ably/ai-transport';

const run = session.createRun(Invocation.fromJSON({ inputEventId, sessionName }), {
  onCancel: async (request) => {
    // request.runId - the targeted runId
    // request.message - the raw Ably cancel message (request.message.clientId is the sender)
    // Return false to reject the cancel (run continues)
    return true;
  },
  onCancelled: async (write) => {
    // Runs after the AbortSignal fires, before the stream closes.
    // Use write() to publish final events before the encoder closes, e.g.:
    // await write({ type: 'text-delta', id: 'msg-1', delta: '[generation cancelled]' });
  },
});

// Pass the AbortSignal to the LLM to stop generation
const result = streamText({
  model,
  messages,
  abortSignal: run.abortSignal,
});
```

The `onCancel` hook authorizes the cancel - return `false` to reject it. Use this to prevent one user from cancelling another user's run. If `onCancel` is not provided, all cancels are accepted.

The `onCancelled` hook runs after the signal fires. The `write` function lets you publish final events (e.g., a partial result summary) before the encoder closes.

## Wire sequence

```mermaid
sequenceDiagram
    participant C as Client
    participant Ch as Ably Channel
    participant S as Server

    C->>Ch: publish(ai-cancel)<br/>headers: run-id and/or input-codec-message-id
    Note left of C: ChatTransport closes its local stream
    Ch->>S: deliver to cancel listener
    Note right of S: look up registered run by id
    Note right of S: onCancel() → true
    Note right of S: fire AbortSignal
    Note right of S: onCancelled(write)
    Note right of S: cancelStreams() closes in-flight streams as cancelled
    S->>Ch: publish ai-run-end (cancelled)
    Ch->>C: deliver ai-run-end
```

Publishing the cancel signal is all the core does — it doesn't wait for the server to confirm. The consumer-facing stream lives in the layer that built it: the Vercel `ChatTransport` closes its stream on cancel. Run cancellation is a transport-tier concern: when the run's `AbortSignal` fires, `pipeStream` calls `encoder.cancelStreams()` to close any in-flight streamed messages as `status: cancelled` (pure transport mechanics — no codec output is emitted), and `Run.pipe` then ends the run with `reason: 'cancelled'`, which publishes the transport `ai-run-end` event that all clients see via run lifecycle events.

## Platform-level cancellation

Ably cancel messages are the primary cancellation path, but the server may also need to cancel a run when the platform signals shutdown - the HTTP request is cancelled, or a serverless function hits its execution timeout.

Pass the platform's `AbortSignal` to `createRun()` via the `signal` option:

```typescript
const run = session.createRun(
  Invocation.fromJSON({ inputEventId, sessionName }),
  { signal: req.signal }, // fires on request cancellation or function timeout
);
```

When the external signal fires, it cancels the run through the same path as an Ably cancel message - `run.abortSignal` fires, `streamText` stops generation, and `pipeStream` closes the stream. The `onCancel` hook is **not** called for platform-level signals (it only fires for Ably cancel messages), but `onCancelled` runs normally.

Internally, `AbortSignal.any()` composes the external signal with the run's own `AbortController`, so either source triggers the same downstream cancellation.

## Cancel and close

`session.close()` tears down only local state — the server keeps streaming until its runs end on their own. To stop in-progress runs before closing, call `run.cancel()` for each first:

```typescript
// Cancel known runs, then close
await run.cancel();
await session.close();
```

If you don't need to stop the server's work, just call `session.close()` on its own.

See [Interruption](interruption.md) for cancel-then-send patterns. See [Error codes](../reference/error-codes.md) for cancel-related error codes. For the internal cancel routing, see [Cancel routing](../internals/transport-components.md#cancel-routing-agent-session).
