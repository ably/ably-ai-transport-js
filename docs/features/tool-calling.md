# Tool calling

Tool calling lets an LLM invoke functions during generation - calling an API, querying a database, or accessing a browser capability like geolocation. AI Transport streams tool invocations and results over Ably so all clients see the full tool interaction, and results persist in channel history.

Without a durable transport layer, tool call sequences break on disconnection. A client that reconnects mid-tool-execution misses the result. Multi-client scenarios are worse: if Client A triggers a client-side tool, Client B has no way to see the result unless the application builds custom signaling.

## How it works

Tools are defined in the AI SDK's `tool()` format and passed to `streamText()`. AI Transport handles two execution models:

| Model               | Where it runs                       | How the result is published                                                                                                                             |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server-executed** | Inside `streamText()` on the server | Automatically - the AI SDK calls `execute`, and the result streams through `run.pipe()`                                                                 |
| **Client-executed** | In the browser (or any client)      | The client sends the result via [`view.update()`](../reference/react-hooks.md#useview) which amends the assistant message and starts a continuation run |

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
import { streamText } from 'ai';
import { z } from 'zod';
import { Invocation } from '@ably/ai-transport';
import { createAgentSession } from '@ably/ai-transport/vercel';

const session = createAgentSession({ client: ably, channelName });
await session.connect();
const run = session.createRun(Invocation.fromJSON({ runId, clientId }));

await run.start();
await run.addMessages(userMessages, { clientId });

const result = streamText({
  model,
  messages: conversationHistory,
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

const { reason } = await run.pipe(result.toUIMessageStream());
await run.end(reason);
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
import type { EventsNode } from '@ably/ai-transport';

// 1. Find the pending tool call in the assistant message (walk the flat TMessage[])
const assistant = view.messages.find(
  (m) =>
    m.role === 'assistant' &&
    m.parts.some((p) => p.type === 'dynamic-tool' && p.toolName === 'getLocation' && p.state === 'input-available'),
);

// 2. Resolve the owning Run so the continuation reuses its runId
const metadata = view.getMessageMetadata(assistant.id);
const runId = metadata?.runId;

// 3. Execute the browser API
const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject));

// 4. Send a continuation tool-resolution event under the existing runId.
//    `domainMessageId` stamps the wire's `x-ably-msg-id` to the assistant's id
//    so the reducer's direct fold path runs.
await view.sendEvent(
  [
    {
      event: {
        type: 'tool-output-available',
        toolCallId: toolPart.toolCallId,
        output: {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        },
      },
      domainMessageId: assistant.id,
    },
  ],
  { runId },
);
```

`sendEvent` with the richer per-entry shape publishes the continuation as a `role: 'user'` wire stamped with `x-ably-run-continue: 'true'`. The Tree's `applyMessage` routes it to the existing Run via `_msgIdToRunId`, folds the tool resolution onto the assistant's projection (no winner update, since continuation wires skip that path), and emits `update`. The agent's `loadProjection()` picks up the new event from the channel and resumes `streamText()` with the tool result in the conversation history. All clients see the tool part transition from `input-available` to `output-available`.

## Multi-client tool execution

When multiple clients share a channel, only the client that initiated the run should execute client-side tools. The `x-ably-run-client-id` header on each message identifies which client started the run. Compare it against the local `clientId` to skip observer tool calls:

```typescript
const metadata = view.getMessageMetadata(assistant.id);
if (metadata?.clientId && metadata.clientId !== myClientId) {
  // This tool call was triggered by another client - skip execution.
  // That client will publish the result, and we'll see it via the channel.
  return;
}
```

Observer clients see the tool call arrive (the assistant message streams normally) and see the result appear when the server publishes the events. No special handling is needed on the observer side.

## Server-side tool result events

For tool calls that require server-mediated approval workflows or deferred execution, the server can publish tool results targeting a previous run's message using `run.addEvents()`:

```typescript
const run = session.createRun(Invocation.fromJSON({ runId, clientId }));
await run.start();

// Publish the tool result targeting a message from a previous run
await run.addEvents([
  {
    kind: 'event',
    msgId: previousAssistantMsgId,
    events: [{ type: 'tool-output-available', toolCallId, output: result }],
  },
]);

// Continue streaming with the tool result in history
const response = streamText({ model, messages: updatedHistory, tools });
await run.pipe(response.toUIMessageStream());
await run.end(reason);
```

## History and persistence

Tool call events persist in Ably channel history. When a client loads history, the decoder reconstructs tool parts with their final state - including cross-run events. A tool that was called, executed, and resolved in a previous session appears with `state: 'output-available'` and the full output.

Cross-run events (from `view.update()` or server-side `run.addEvents()`) are stored in history with `x-ably-amend` header identifying the target message. The history decoder detects these and routes them to the correct message's accumulator, so the tool part state is reconstructed correctly.

To avoid re-executing client tools after a page refresh, check whether the tool call already has a follow-up assistant message (which means the model already consumed the result):

```typescript
const hasFollowUp = nodes.slice(i + 1).some((n) => n.message.role === 'assistant');
if (hasFollowUp) continue; // Already resolved in a previous session
```

See [Streaming](streaming.md) for how tool input deltas are encoded as message appends. See [Branching](branching.md) for how tool calls interact with conversation forks. See [React hooks reference](../reference/react-hooks.md#useview) for the `update` API on `ViewHandle`.
