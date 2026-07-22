# Tool calling

Tool calling lets an LLM invoke functions during generation - calling an API, querying a database, or accessing a browser capability like geolocation. AI Transport streams tool invocations and results over Ably so all clients see the full tool interaction, and results persist in channel history.

Without a durable transport layer, tool call sequences break on disconnection. A client that reconnects mid-tool-execution misses the result. Multi-client scenarios are worse: if Client A triggers a client-side tool, Client B has no way to see the result unless the application builds custom signaling.

## How it works

Tools are defined in the AI SDK's `tool()` format and passed to `streamText()`. AI Transport handles two execution models:

| Model               | Where it runs                       | How the result is published                                                                                                                                                                                                |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server-executed** | Inside `streamText()` on the server | Automatically - the AI SDK calls `execute`, and the result streams through `run.pipe()`                                                                                                                                    |
| **Client-executed** | In the browser (or any client)      | The client sends a `tool-result` input via [`view.send()`](../reference/react-hooks.md#useview), forking the suspended tool call into its own reply run (a sibling of the suspended run) that carries this client's result |

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

// Drain run.view for the full multi-turn conversation to feed the model (this also
// folds in the triggering input that start() waits for); run.messages is only this run (all its segments).
while (run.view.hasOlder()) await run.view.loadOlder();
const conversation = run.view.getMessages().map((m) => m.message);
await run.start();

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
import { createToolResultFork, createUIMessageCodec } from '@ably/ai-transport/vercel';

// The codec is stateless — assemble one to reconstruct the run's messages.
const codec = createUIMessageCodec();

// 1. Find the pending tool call in the assistant message. Walk the flat
//    list paired with codec-message-ids so we can address the result back to
//    the transport — the assistant's domain `message.id` is independent of the
//    codec-message-id and is never used for correlation.
// `getLocation` is declared statically on the server (in `streamText`'s
// `tools`), so the codec reconstructs it as a `tool-${name}` part — the name is
// encoded in the `type`, not a separate `toolName` field. (A tool declared
// dynamically would instead be `type: 'dynamic-tool'` with `toolName`.)
const assistant = view
  .getMessages()
  .find(
    ({ message }) =>
      message.role === 'assistant' &&
      message.parts.some((p) => p.type === 'tool-getLocation' && p.state === 'input-available'),
  );
const toolPart = assistant?.message.parts.find((p) => p.type === 'tool-getLocation' && p.state === 'input-available');

// 2. Resolve the suspended run node — its full projection (for the fork seed)
//    and its input node (the fork's parent), both read authoritatively from the
//    run, not guessed from message order.
const run = view.runOf(assistant.codecMessageId);
const node = session.tree.getRunNode(run.runId);

// 3. Execute the browser API
const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject));

// 4. Fork the tool call into its own reply run and publish the result.
//    `createToolResultFork` builds the tool-result input (carrying a
//    self-contained copy of the suspended run's messages, so the fork
//    reconstructs its full context) plus the RUN-LESS send options (the fork's
//    parent = the suspended run's input node, and role: 'assistant'; NO run-id —
//    the agent mints the fork's run-id). Publishing them forks a sibling reply
//    run, so concurrent answers to one tool call stay segregated.
const { input, sendOptions } = createToolResultFork({
  runMessages: codec.getMessages(node.projection),
  parentCodecMessageId: node.parentCodecMessageId,
  toolCallId: toolPart.toolCallId,
  result: { output: { latitude: position.coords.latitude, longitude: position.coords.longitude } },
  // The run this fork resolves is superseded — the tree hides that now-dead run
  // so a single response renders as one linear reply (only concurrent forks branch).
  supersedesRunId: run.runId,
});
await view.send([input], sendOptions);
```

When the LLM requests a client-executed tool (or an approval) the agent has no result to stream, so it **suspends** the run — publishing `ai-run-suspend` rather than the terminal `ai-run-end` — and the run stays live in the conversation tree awaiting the result.

Client tool resolutions are `tool-result` (or `tool-result-error`) inputs - they ride the `ai-input` wire, the same direction as user messages, so the publisher matches the wire (client to input, agent to output). Each resolution opens its **own reply run** — a _fork_ of the suspended run. The fork is published **run-less** (carrying `role: 'assistant'` and a `parent`, but no run-id): the tree treats it as a client-owned optimistic reply run keyed by the tool-result's codec-message-id, the **agent** mints the fork's run id and starts that run with `ai-run-start` (not `ai-run-resume`) parented as a same-parent sibling of the suspended run, and the tree reconciles the optimistic reply run onto the agent-minted id by that codec-message-id (via the `input-codec-message-id` the agent echoes on run-start). The resolution carries a self-contained copy of the suspended run's messages (so a multi-step run keeps its earlier resolved tool calls), and the fork run reconstructs them with **this** result folded in, then the agent resumes `streamText()` with the full history.

The fork also carries `supersedes` — the run-id of the suspended run it resolves. That run is now dead (nothing resumes it; its answer went to the fork), so the tree marks it superseded and **hides it from branch selection**. The effect: a **single** client's single response renders as **one linear reply** (the dead trunk is not shown as a sibling), while **concurrent** forks from multiple clients — which each supersede the same trunk — remain **segregated sibling branches**. On failure, send a `tool-result-error` input with a `message` field instead of `output`. See [Branching](branching.md) and [Wire protocol](../internals/wire-protocol.md#run-id-on-a-continuation) for the fork mechanics.

## Multi-client tool execution

When multiple clients share a channel, more than one may execute the same client-side tool — most commonly two tabs authenticated with the **same `clientId`**. AI Transport handles this gracefully: because each resolution forks its own reply run (above), two clients answering the same tool call produce two **segregated sibling branches** — one per answer — with no errors and no cross-contamination of either the agent's prompt or the rendered conversation. Navigate between them with [branch selection](branching.md#branch-navigation), exactly as with a regenerated reply.

If you would rather have a single client respond (to avoid redundant executions across _different_ clientIds), gate execution on the run owner — the `run-client-id` header identifies which client started the run:

```typescript
const run = view.runOf(assistant.codecMessageId);
if (run?.clientId && run.clientId !== myClientId) {
  // A different client owns this run - let it publish the result.
  // (This is an optional optimization; letting both respond is safe too.)
  return;
}
```

This gate skips only when a **different** client owns the run; it does not fire for two tabs sharing one `clientId`, where both execute — and the forking above keeps those answers cleanly separated. Observer clients that do not execute the tool see each answer's branch appear as its owning client publishes its `tool-result`.

## History and persistence

Tool call events persist in Ably channel history. When a client loads history, the decoder reconstructs tool parts with their final state - including cross-run events. A tool that was called, executed, and resolved in a previous session appears with `state: 'output-available'` and the full output.

When the agent reconstructs a prompt by draining [`run.view`](../concepts/runs.md), a prior turn whose run never completed - a tool call left unresolved because the run was suspended, cancelled, or errored - is omitted from that prompt along with the turn's user input, so a dangling tool call can't invalidate the request sent to the model.

Cross-run events (from a client `tool-result` input via `view.send()`) carry the `codec-message-id` of the message they target. When loading history, the SDK routes these amend events to the correct message and folds them through the codec's reducer, so the tool part state is reconstructed correctly.

To avoid re-executing client tools after a page refresh, check whether the tool call already has a follow-up assistant message (which means the model already consumed the result):

```typescript
const hasFollowUp = messages.slice(i + 1).some((m) => m.role === 'assistant');
if (hasFollowUp) continue; // Already resolved in a previous session
```

See [Streaming](streaming.md) for how tool input deltas are encoded as message appends. See [Branching](branching.md) for how tool calls interact with conversation forks. See [React hooks reference](../reference/react-hooks.md#useview) for the `send` API on `ViewHandle`.
