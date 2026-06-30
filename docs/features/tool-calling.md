# Tool calling

Tool calling lets an LLM invoke functions during generation - calling an API, querying a database, or accessing a browser capability like geolocation. AI Transport streams tool invocations and results over Ably so all clients see the full tool interaction, and results persist in channel history.

Without a durable transport layer, tool call sequences break on disconnection. A client that reconnects mid-tool-execution misses the result. Multi-client scenarios are worse: if Client A triggers a client-side tool, Client B has no way to see the result unless the application builds custom signaling.

## How it works

Tools are defined in the AI SDK's `tool()` format and passed to `streamText()`. AI Transport handles two execution models:

| Model               | Where it runs                       | How the result is published                                                                                                                                                           |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server-executed** | Inside `streamText()` on the server | Automatically - the AI SDK calls `execute`, and the result streams through `run.pipe()`                                                                                               |
| **Client-executed** | In the browser (or any client)      | The client sends a `tool-result` input via [`view.send()`](../reference/react-hooks.md#useview), which amends the suspended assistant message and continues the run under its `runId` |

Tool events flow through the codec like any other streaming content. The Vercel codec maps tool lifecycle to these wire events:

| Event                   | Meaning                                      | Ably encoding             |
| ----------------------- | -------------------------------------------- | ------------------------- |
| `tool-input-start`      | Model is calling a tool                      | Message create (streamed) |
| `tool-input-delta`      | Streaming JSON input fragment                | Message append            |
| `tool-input-available`  | Tool input complete, ready for execution     | Message append (closing)  |
| `tool-output-available` | Tool execution succeeded with a result       | Discrete message          |
| `tool-output-error`     | Tool execution failed                        | Discrete message          |
| `tool-approval-request` | Tool requires user approval before execution | Discrete message          |

## Server-executed tools

Define tools with an `execute` function. The AI SDK calls them automatically during `streamText()` and the results stream to all clients via the encoder:

```typescript
import { streamText, convertToModelMessages } from 'ai';
import { z } from 'zod';
import { Invocation, type InvocationData } from '@ably/ai-transport';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';

const data = (await req.json()) as InvocationData;
const invocation = Invocation.fromJSON(data);

const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
await session.connect();
const run = session.createRun(invocation, { signal: req.signal });

await run.start();

// Drain run.view for the full multi-turn conversation to feed the model.
// run.messages is only this run's own turn.
while (run.view.hasOlder()) await run.view.loadOlder();
const conversation = run.view.getMessages().map((m) => m.message);

const result = streamText({
  model,
  messages: await convertToModelMessages(conversation),
  tools: {
    getWeather: {
      description: 'Get the current weather for a location.',
      inputSchema: z.object({
        location: z.string().describe('City and state, e.g. "San Francisco, CA"'),
      }),
      execute: async ({ location }) => {
        const data = await fetchWeatherAPI(location);
        return { location, temperature: data.temp, conditions: data.summary };
      },
    },
  },
  abortSignal: run.abortSignal,
});

const pipeResult = await run.pipe(result.toUIMessageStream());
const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
if (outcome.reason === 'suspend') {
  await run.suspend();
} else {
  await run.end(outcome);
}
```

The model decides to call `getWeather`, the AI SDK executes it on the server, and the encoder publishes both the tool input (streamed) and tool output (discrete) to the channel. All clients see the tool call and result appear in the assistant message's parts.

## Client-executed tools

Some tools need capabilities only available in the browser - geolocation, camera access, local file selection. Define these tools without an `execute` function. The model calls the tool, the stream finishes with `finishReason: 'tool-calls'`, and the client handles execution.

### Server

Define the tool with `outputSchema` but no `execute`:

```typescript
const tools = {
  getLocation: {
    description: "Get the user's current location from their browser.",
    inputSchema: z.object({
      reason: z.string().describe('Why the location is needed'),
    }),
    outputSchema: z.object({
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      error: z.string().optional(),
    }),
    // No execute — the client handles this
  },
};
```

### Client

Watch for tool parts in the `input-available` state, execute the browser API, then publish the result back to the channel:

```typescript
import { UIMessageCodec } from '@ably/ai-transport/vercel';

// 1. Find the pending tool call in the assistant message. Walk the flat
//    list paired with codec-message-ids so we can address the result back to
//    the transport — the assistant's domain `message.id` is independent of the
//    codec-message-id and is never used for correlation.
const assistant = view
  .getMessages()
  .find(
    ({ message }) =>
      message.role === 'assistant' &&
      message.parts.some(
        (p) => p.type === 'dynamic-tool' && p.toolName === 'getLocation' && p.state === 'input-available',
      ),
  );

const toolPart = assistant?.message.parts.find(
  (p) => p.type === 'dynamic-tool' && p.toolName === 'getLocation' && p.state === 'input-available',
);

// 2. Resolve the owning Run so the continuation reuses its runId
const run = view.runOf(assistant.codecMessageId);
const runId = run?.runId;

// 3. Execute the browser API
const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject));

// 4. Send a continuation `tool-result` input under the existing runId.
//    The codec-message-id (`assistant.codecMessageId`) addresses the assistant
//    message holding the tool call, so the reducer folds the result onto it. The
//    codec-supplied payload carries the domain-specific fields (`toolCallId`,
//    `output`). Routing lives on the input itself - no wrapper object.
await view.send(
  UIMessageCodec.createToolResult(assistant.codecMessageId, {
    toolCallId: toolPart.toolCallId,
    output: {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    },
  }),
  { runId },
);
```

When the LLM requests a client-executed tool (or an approval) the agent has no result to stream, so it **suspends** the run — publishing `ai-run-suspend` rather than the terminal `ai-run-end` — and the run stays live in the conversation tree awaiting the result.

Client tool resolutions are `tool-result` (or `tool-result-error`) inputs - they ride the `ai-input` wire, the same direction as user messages, so the publisher matches the wire (client to input, agent to output). The continuation reuses the run's `runId` so the agent picks the result up off the channel and resumes `streamText()` with the tool result in history; it re-enters the run with an `ai-run-resume` lifecycle event (not a fresh `ai-run-start`). The reducer folds the result onto the assistant addressed by `codecMessageId`, and all clients see the tool part transition from `input-available` to `output-available`. On failure, send a `tool-result-error` input with a `message` field instead of `output`.

## Multi-client tool execution

When multiple clients share a channel, only the client that initiated the run should execute client-side tools. The `run-client-id` header on each message identifies which client started the run. Compare it against the local `clientId` to skip observer tool calls:

```typescript
const run = view.runOf(assistant.codecMessageId);
if (run?.clientId && run.clientId !== myClientId) {
  // This tool call was triggered by another client - skip execution.
  // That client will publish the result, and we'll see it via the channel.
  return;
}
```

Observer clients see the tool call arrive (the assistant message streams normally) and see the result appear when the initiating client publishes its `tool-result` input and the run resumes. No special handling is needed on the observer side.

## History and persistence

Tool call events persist in Ably channel history. When a client loads history, the decoder reconstructs tool parts with their final state - including cross-run events. A tool that was called, executed, and resolved in a previous session appears with `state: 'output-available'` and the full output.

Cross-run events (from a client `tool-result` input via `view.send()`) carry the `codec-message-id` of the message they target. When loading history, the SDK routes these amend events to the correct message and folds them through the codec's reducer, so the tool part state is reconstructed correctly.

To avoid re-executing client tools after a page refresh, check whether the tool call already has a follow-up assistant message (which means the model already consumed the result):

```typescript
const hasFollowUp = messages.slice(i + 1).some((m) => m.role === 'assistant');
if (hasFollowUp) continue; // Already resolved in a previous session
```

See [Streaming](streaming.md) for how tool input deltas are encoded as message appends. See [Branching](branching.md) for how tool calls interact with conversation forks. See [React hooks reference](../reference/react-hooks.md#useview) for the `send` API on `ViewHandle`.
