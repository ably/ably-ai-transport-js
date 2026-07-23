# OpenAI Agents SDK: event structure and tool approvals

This doc compares the OpenAI codec's wire model against the OpenAI Agents SDK
(`@openai/agents`, the JS/TS SDK), and explains how the Agents SDK handles tool
approvals. It exists to answer one question for the [OpenAI codec](openai-codec.md):
if we add client-side tool calling and tool approvals, can we reuse what the
Agents SDK already defines instead of inventing a parallel model?

The short version: the codec already speaks the Agents SDK's raw event format,
because both carry the raw OpenAI Responses stream. Tool _results_ line up
directly. Tool _approvals_ sit in a layer the Agents SDK keeps above the event
stream, so there is no OpenAI event to pass through for them — the Agents SDK
invents its own approval representation, and if we want approvals we either
mirror that representation or invent our own.

Versions surveyed: `openai-agents-js` `main` (RunState serialization schema
1.7), `openai` 6.45.0 (the version this package pins).

## What the codec uses today

The [OpenAI codec](openai-codec.md) binds its `TOutput` to the raw OpenAI
Responses stream: a `Responses.ResponseStreamEvent` (see
`src/openai/codec/events.ts`). The agent pipes the `/v1/responses` SSE stream
through the codec as-is, and the descriptor table in
`src/openai/codec/descriptors.ts` curates which of those events reach the wire.
Assistant output is a list of Responses items (`OpenAIItem`), and every stored
item is a valid `ResponseInputItem`, so a conversation round-trips back into a
`/responses` call with no conversion (`src/openai/to-responses-input.ts`).

The codec does not use the Agents SDK. It talks to the Responses API directly.

## The Agents SDK event model

The Agents SDK wraps the same Responses stream in its own runner and emits three
top-level streaming event types (`packages/agents-core/src/events.ts`):

```
RunStreamEvent =
  | RunRawModelStreamEvent      // type: 'raw_model_stream_event'
  | RunItemStreamEvent          // type: 'run_item_stream_event'
  | RunAgentUpdatedStreamEvent  // type: 'agent_updated_stream_event'
```

- **`RunRawModelStreamEvent`** carries `data` plus a `source` string. For the
  Responses model the `source` is `'openai-responses'` and `data` is the raw
  provider event. This layer is the same stream the OpenAI codec already models.
  In other words, the codec's whole wire format equals the Agents SDK's raw
  layer for `source: 'openai-responses'`.
- **`RunItemStreamEvent`** carries a semantic `RunItem` under a `name`. The
  names are: `message_output_created`, `handoff_requested`, `handoff_occurred`,
  `tool_search_called`, `tool_search_output_created`, `tool_called`,
  `tool_output`, `reasoning_item_created`, and `tool_approval_requested`. This
  is a higher-level view the SDK derives from the raw stream. The codec has no
  equivalent, and does not need one: its reducer folds the raw events into
  Responses items directly.
- **`RunAgentUpdatedStreamEvent`** signals a handoff to a different agent. The
  codec has no notion of multiple agents, so this has no counterpart.

Each `RunItem` holds a `rawItem` that is the underlying Responses protocol item
(`packages/agents-core/src/items.ts`). For example `RunToolCallItem.rawItem` is
the tool-call item and `RunToolCallOutputItem.rawItem` is the tool-call output.
The `RunItem` layer is a labelled wrapper over the same protocol items the codec
stores.

### How this maps to the codec

| Agents SDK                                                 | OpenAI codec equivalent                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `raw_model_stream_event` (`source: openai-responses`)      | The wire format itself — `Responses.ResponseStreamEvent`         |
| `RunToolCallItem.rawItem` (a `function_call`)              | A `function_call` output item, folded by the reducer's item arms |
| `RunToolCallOutputItem.rawItem` (a `function_call_output`) | The codec's `function_call_output` event and stored item         |
| `run_item_stream_event` labelling                          | No equivalent — the reducer folds raw events straight into items |
| `agent_updated_stream_event`                               | No equivalent — the codec models a single agent                  |

The takeaway for the raw stream and for tool calls: the Agents SDK adds a
semantic labelling layer, and underneath it the items are the same Responses
items the codec already stores. Nothing about tool _calls_ or tool _results_
requires a new representation.

## Tool approvals in the Agents SDK

Approvals are where the Agents SDK adds something that is not in the Responses
event stream at all.

### Declaring an approval gate

A tool declares that it needs approval with the `needsApproval` option, either a
boolean or an async function of the tool arguments that returns a boolean
(`packages/agents-core/src/tool.ts`). This is an Agents SDK concept. The
Responses API has no `needsApproval` field on a plain function tool.

### Pausing the run

When a gated tool is about to run and no decision is stored, the run does not
execute the tool. It records a `RunToolApprovalItem` and pauses. The caller
reads the pending items from `result.interruptions`, which is an array of
`RunToolApprovalItem` (`packages/agents-core/src/result.ts`,
`packages/agents-core/src/runState.ts` `getInterruptions()`).

A `RunToolApprovalItem` (`items.ts`) has `type: 'tool_approval_item'` and holds:

- `rawItem` — one of `protocol.FunctionCallItem`, `HostedToolCallItem`,
  `ComputerUseCallItem`, `ShellCallItem`, or `ApplyPatchCallItem`. For an
  ordinary function tool this is the plain `function_call`.
- `agent` — the agent that raised it.
- `toolName` — the tool name for tracking, and a `name` / `arguments` getter
  that read from the raw item.

The important detail: the approval item wraps a plain `function_call`. The
Agents SDK gates ordinary function tools, not only hosted MCP tools. The gate is
an SDK-level construct, not a Responses feature.

### Recording the decision

The caller approves or rejects each interruption on the run state and then
resumes:

```ts
for (const interruption of result.interruptions) {
  if (userApproved(interruption)) state.approve(interruption);
  else state.reject(interruption, { message: 'not allowed' });
}
result = await run(agent, state);
```

`state.approve(item, { alwaysApprove? })` and `state.reject(item,
{ alwaysReject?, message? })` mutate the decision store on the run context
(`runState.ts`). They do not emit a Responses item. The decision lives entirely
in the run state.

### Where the decision is stored

The decision store is part of the serializable `RunState`. Its schema
(`runState.ts`, `context.approvals`) is:

```
approvals: Record<string /* tool name */, {
  approved: string[] | boolean   // approved call ids, or true for "always"
  rejected: string[] | boolean   // rejected call ids, or true for "always"
  messages?: Record<string, string>   // call id -> rejection message
  stickyRejectMessage?: string
}>
```

Hosted MCP approval requests are tracked separately in
`context.mcpApprovalRequests`, each holding the hosted-tool-call raw item.

`RunState` serializes to a string and rehydrates with `RunState.fromString(agent,
string)`, so a paused run — including its pending approvals and recorded
decisions — survives across processes and sessions. This is the mechanism the
Agents SDK offers for human-in-the-loop across a network boundary.

### The one place approvals do ride the Responses wire: MCP

Hosted MCP tools are the exception. The Responses API itself defines
`mcp_approval_request` (an output item) and `mcp_approval_response` (an input
item, part of `ResponseInputItem`). For MCP tools the approval is a real
Responses item that round-trips through `/responses`. For a plain function tool
there is no such item, and the Agents SDK's `RunToolApprovalItem` plus
`RunState` is the only representation.

## Implications for the OpenAI codec

Tool results are straightforward. A client-executed tool result is a
`function_call_output` item. That item is already a `ResponseInputItem`, the
codec already models it as the server-side `function_call_output` output event,
and the Agents SDK stores the same item as `RunToolCallOutputItem.rawItem`. A
client `tool-result` input therefore reuses a representation that all three
agree on. There is nothing to reinvent.

Tool approvals are the real question, and the research narrows it to a clear
choice rather than an open design:

- There is no Responses event to pass through for a plain-function-tool
  approval. The Agents SDK does not surface plain-tool approvals in the model
  event stream. It surfaces them as `RunToolApprovalItem` interruptions and
  records the decision in the serializable `RunState`, both above the stream.
- So any approval support in the codec models a representation that is not a
  native Responses event, exactly as the Agents SDK does. "Reuse the Agents SDK
  instead of reinventing" means aligning the codec's approval wire events with
  the Agents SDK's shapes and vocabulary, not passing an OpenAI event through.
  The natural mapping is:
  - a `tool-approval-request` output that carries the pending call's `call_id`,
    tool `name`, and `arguments` — the fields a `RunToolApprovalItem` exposes;
  - a `tool-approval-response` input that carries `call_id`, an `approved`
    boolean, and an optional `reason` — the inputs to `state.approve` /
    `state.reject`, and the `approved` / `rejected` / `messages` fields of the
    `approvals` store.
    These are the same three fields the Vercel codec's approval payload already
    carries, so aligning with the Agents SDK and aligning with the existing Vercel
    payload point at the same shape.
- Hosted MCP approvals are a separate, later path. They map to the native
  `mcp_approval_request` / `mcp_approval_response` items, and depend on MCP
  support arriving first (tracked under AIT-1121).

A second option remains open: if an agent is built on `@openai/agents` rather
than on raw `/responses`, the transport could carry the serialized `RunState`
as the approval-bearing payload and let the SDK's `approve` / `reject` / resume
loop do the work. That trades a small, codec-native approval event for a
dependency on the Agents SDK's state format. This doc records the option; the
[feature spec](../../feature_spec_add_missing_tool_calling_to_openai_codec.md)
is where the choice gets made.

## Code references

OpenAI codec (this repo):

- `src/openai/codec/events.ts` — `OpenAIOutput` bound to `ResponseStreamEvent`; `OpenAIInput` (user message + regenerate today).
- `src/openai/codec/descriptors.ts` — the `function_call_arguments` stream and the codec's own `function_call_output` event.
- `src/openai/to-responses-input.ts` — the `OpenAIItem -> ResponseInputItem` round-trip boundary.

Agents SDK (`openai/openai-agents-js`, `packages/agents-core/src`):

- `events.ts` — `RunRawModelStreamEvent`, `RunItemStreamEvent`, `RunItemStreamEventName`.
- `items.ts` — `RunItem` union and `RunToolApprovalItem`.
- `tool.ts` — the `needsApproval` option.
- `result.ts` / `runState.ts` — `interruptions`, `approve` / `reject`, the `approvals` schema, `RunState.fromString`.

## Related documentation

- [OpenAI codec](openai-codec.md) — the codec and its current tool-calling gap.
- [Tool calling](../features/tool-calling.md) — the feature and the suspend/resume flow.
- [Streaming | OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/streaming/)
- [Human-in-the-loop | OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- [Results | OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/results/)
