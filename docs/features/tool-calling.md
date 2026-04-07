# Tool calling

Tool calling lets an LLM invoke functions during generation - calling an API, querying a database, or accessing a browser capability like geolocation. AI Transport streams tool invocations and results over Ably so all clients see the full tool interaction, and results persist in channel history.

Without a durable transport layer, tool call sequences break on disconnection. A client that reconnects mid-tool-execution misses the result. Multi-client scenarios are worse: if Client A triggers a client-side tool, Client B has no way to see the result unless the application builds custom signaling.

## How it works

Tools are defined in the AI SDK's `tool()` format and passed to `streamText()`. AI Transport handles two execution models:

| Model | Where it runs | How the result is published |
|---|---|---|
| **Server-executed** | Inside `streamText()` on the server | Automatically - the AI SDK calls `execute`, and the result streams through `turn.streamResponse()` |
| **Client-executed** | In the browser (or any client) | The client sends the result via [`view.update()`](../reference/react-hooks.md#useview) which amends the assistant message and starts a continuation turn |

Tool events flow through the codec like any other streaming content. The Vercel codec maps tool lifecycle to these wire events:

| Event | Meaning | Ably encoding |
|---|---|---|
| `tool-input-start` | Model is calling a tool | Message create (streamed) |
| `tool-input-delta` | Streaming JSON input fragment | Message append |
| `tool-input-available` | Tool input complete, ready for execution | Message append (closing) |
| `tool-output-available` | Tool execution succeeded with a result | Discrete message |
| `tool-output-error` | Tool execution failed | Discrete message |
| `tool-approval-request` | Tool requires user approval before execution | Discrete message |

## Server-executed tools

Define tools with an `execute` function. The AI SDK calls them automatically during `streamText()` and the results stream to all clients via the encoder:

```typescript
import { streamText } from 'ai';
import { z } from 'zod';
import { createServerTransport } from '@ably/ai-transport/vercel';

const transport = createServerTransport({ channel });
const turn = transport.newTurn({ turnId, clientId });

await turn.start();
await turn.addMessages(userMessages, { clientId });

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
  abortSignal: turn.abortSignal,
});

const { reason } = await turn.streamResponse(result.toUIMessageStream());
await turn.end(reason);
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

// 1. Find the pending tool call in the assistant message
const node = view.nodes.find(n =>
  n.message.role === 'assistant' &&
  n.message.parts.some(p =>
    p.type === 'dynamic-tool' &&
    p.toolName === 'getLocation' &&
    p.state === 'input-available'
  )
);

// 2. Execute the browser API
const position = await new Promise((resolve, reject) =>
  navigator.geolocation.getCurrentPosition(resolve, reject)
);

// 3. Update the assistant message with the result and start a continuation turn
await view.update(node.msgId, [{
  type: 'tool-output-available',
  toolCallId: toolPart.toolCallId,
  output: {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
  },
}]);
```

`update` updates the existing assistant message and starts a continuation [turn](../concepts/turns.md) in a single call. The tree updates optimistically, then the events are sent to the server in the POST body. The server publishes them to the channel (with `x-ably-amend` header targeting the assistant message's `x-ably-msg-id`) and calls `streamText()` again with the tool result in the conversation history. All clients see the tool part transition from `input-available` to `output-available`.

## Multi-client tool execution

When multiple clients share a channel, only the client that initiated the turn should execute client-side tools. The `x-ably-turn-client-id` header on each message identifies which client started the turn. Compare it against the local `clientId` to skip observer tool calls:

```typescript
const turnClientId = node.headers['x-ably-turn-client-id'];
if (turnClientId !== myClientId) {
  // This tool call was triggered by another client — skip execution.
  // That client will publish the result, and we'll see it via the channel.
  return;
}
```

Observer clients see the tool call arrive (the assistant message streams normally) and see the result appear when the server publishes the events. No special handling is needed on the observer side.

## Server-side tool result events

For tool calls that require server-mediated approval workflows or deferred execution, the server can publish tool results targeting a previous turn's message using `turn.addEvents()`:

```typescript
const turn = transport.newTurn({ turnId, clientId });
await turn.start();

// Publish the tool result targeting a message from a previous turn
await turn.addEvents([{
  kind: 'event',
  msgId: previousAssistantMsgId,
  events: [{ type: 'tool-output-available', toolCallId, output: result }],
}]);

// Continue streaming with the tool result in history
const response = streamText({ model, messages: updatedHistory, tools });
await turn.streamResponse(response.toUIMessageStream());
await turn.end(reason);
```

## History and persistence

Tool call events persist in Ably channel history. When a client loads history, the decoder reconstructs tool parts with their final state - including cross-turn events. A tool that was called, executed, and resolved in a previous session appears with `state: 'output-available'` and the full output.

Cross-turn events (from `view.update()` or server-side `turn.addEvents()`) are stored in history with `x-ably-amend` header identifying the target message. The history decoder detects these and routes them to the correct message's accumulator, so the tool part state is reconstructed correctly.

To avoid re-executing client tools after a page refresh, check whether the tool call already has a follow-up assistant message (which means the model already consumed the result):

```typescript
const hasFollowUp = nodes.slice(i + 1).some(n => n.message.role === 'assistant');
if (hasFollowUp) continue; // Already resolved in a previous session
```

See [Streaming](streaming.md) for how tool input deltas are encoded as message appends. See [Branching](branching.md) for how tool calls interact with conversation forks. See [React hooks reference](../reference/react-hooks.md#useview) for the `update` API on `ViewHandle`.
