# Tool calls

Tool call events flow through AI Transport like any other streaming content. The transport doesn't orchestrate tools - it streams the tool call chunks from server to client. The LLM framework (e.g., Vercel AI SDK's `streamText()`) handles tool execution; AI Transport delivers the results over the Ably channel.

Without durable transport, tool call sequences can break mid-stream. With AI Transport, tool input deltas, results, and multi-step chains are all persisted on the channel and available through history.

## How it works

Tool calls are codec events. For the Vercel AI SDK codec (`UIMessageCodec`):

| Event type | What it represents | Ably encoding |
|---|---|---|
| `tool-input-start` | A tool is being called (tool name, call ID) | Message create |
| `tool-input-delta` | Streaming JSON input for the tool | Message append |
| `tool-input-available` | Tool input is complete | Message close |
| `tool-input-error` | Tool input failed | Discrete message |
| `tool-output-available` | Tool returned a result | Discrete message |

Tool input streams work like text streams - deltas are appended to a message, and the decoder accumulates them into a complete tool invocation. Tool outputs are discrete messages published after the tool executes.

## Server

No special transport API is needed. Define tools with `streamText()` and pipe the result through the turn:

```typescript
import { streamText } from 'ai';
import { z } from 'zod';

const result = streamText({
  model,
  messages: conversationHistory,
  abortSignal: turn.abortSignal,
  tools: {
    getWeather: {
      description: 'Get the current weather for a location',
      parameters: z.object({
        location: z.string().describe('City name'),
      }),
      execute: async ({ location }) => {
        const weather = await fetchWeather(location);
        return { temperature: weather.temp, conditions: weather.conditions };
      },
    },
  },
});

const { reason } = await turn.streamResponse(result.toUIMessageStream());
await turn.end(reason);
```

`streamText()` handles tool execution automatically (multi-step tool use is built into the AI SDK v6). The resulting `UIMessageChunk` stream includes tool-input chunks, tool-output chunks, and any follow-up text the model generates after seeing the tool result. AI Transport streams all of these over the Ably channel.

## Client

On the client, tool calls appear as parts of the assistant message. No special handling is needed - they're decoded by the codec and included in the message's `parts` array:

```typescript
// Using useMessages or useConversationTree
const messages = useMessages(transport);

messages.forEach((msg) => {
  msg.parts.forEach((part) => {
    if (part.type === 'tool-invocation') {
      // part.toolInvocation.toolName - which tool was called
      // part.toolInvocation.args - the parsed arguments
      // part.toolInvocation.state - 'partial-call' | 'call' | 'result'
      // part.toolInvocation.result - the tool's return value (when state === 'result')
    }
  });
});
```

Tool invocation state progresses as chunks arrive:
- `'partial-call'` - tool input is still streaming
- `'call'` - input is complete, tool is executing
- `'result'` - tool has returned a result

## History

Tool call messages are persisted on the channel as with any other message. A client loading history sees the full tool call sequence - inputs, outputs, and any follow-up text. The messages contain the complete accumulated tool input JSON, so late-joining clients don't need to replay individual deltas.

See [Token streaming](streaming.md) for how message encoding works. See [History](history.md) for loading tool call history on page refresh. See [React hooks reference](../reference/react-hooks.md) for the `useMessages()` API.
