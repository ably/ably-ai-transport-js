# OpenAI codec

The OpenAI codec (`src/openai/codec/`) implements the [Codec interface](codec-interface.md) for the OpenAI Responses API, mapping between `ResponseStreamEvent` outputs and Ably channel operations. Like the [Vercel codec](vercel-codec.md), it is assembled by `defineCodec` from a reducer, declarative descriptor tables (`descriptors.ts`), a decode-lifecycle policy, and a `factories` selector — there are no hand-written encoder/decoder classes. The factory is `ResponsesCodec` (`src/openai/codec/index.ts`).

The codec models user prompts, streamed assistant text, refusals, reasoning (summary and raw text), server-side function calls, and the full client-side tool surface: client-executed tools, tool failures, and human tool approvals. It matches the [Vercel codec](vercel-codec.md)'s tool-calling completeness. The one remaining gap is **hosted tools** (web/file search, code interpreter, image generation, MCP, custom tools), tracked under `TODO(AIT-1121)`.

## Server-executed function calls

A server-executed function call is one the agent runs itself, inside the same run. The codec carries the full round trip:

| Direction    | Wire representation                                                                                                                                                                                 | Where declared                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| agent→client | `function_call_arguments` stream — opens on `response.output_item.added` (matched only for a `function_call` item), streams the `arguments` text, closes on `response.function_call_arguments.done` | `outputs` in `descriptors.ts` |
| agent→client | `response.output_item.added` / `.done` — carry the `function_call` item envelope                                                                                                                    | `outputs` in `descriptors.ts` |
| agent→client | `function_call_output` — the codec's own discrete event, not a Responses stream event; the agent publishes it after running the tool                                                                | `outputs` in `descriptors.ts` |

The Responses API surfaces a tool's result only as model input on the next turn, so there is no OpenAI stream event for it. The agent runs the tool, publishes `function_call_output`, and continues the run. The reducer folds that output item into the message its codec-message-id names, paired with its `function_call` by `call_id` at render time. Every part of this exchange originates on the agent side, and the server-side `function_call_output` arm _appends_ — each server output is distinct.

## Client-side tools and approvals

The three client-driven exchanges — a client executing a tool, a client reporting a tool failure, and a human approving or denying a gated tool — all depend on the **client** sending an `ai-input` event back to the agent, and on the agent **suspending** a run to wait for it (see [tool calling](../features/tool-calling.md) for how suspend/resume drives client tools).

### Client→agent inputs

`OpenAIInput` carries all three well-known tool input variants alongside `user-message` and `regenerate`:

| Input variant            | Payload (`src/openai/codec/events.ts`)                                         | Meaning                                                               |
| ------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `tool-result`            | `OpenAIToolResultPayload` (`call_id`, `output`)                                | The client executed a tool and returns its output                     |
| `tool-result-error`      | `OpenAIToolResultErrorPayload` (`call_id`, `message`)                          | The client tried to execute a tool and it failed, returning a message |
| `tool-approval-response` | `OpenAIToolApprovalResponsePayload` (`call_id`, `approved`, optional `reason`) | The user approved or denied an approval request                       |

Each is declared as an input descriptor in `inputs` (`descriptors.ts`), keyed by `call_id` on the wire (`fCallId`). Because `OpenAIInput` carries these variants, the three optional well-known factories (`createToolResult`, `createToolResultError`, `createToolApprovalResponse`) are on at the type level, and `ResponsesCodec`'s `factories` selector returns the full set unchanged (`factories: (base) => base`).

### Agent→client approval output

To gate a tool on a human decision the agent publishes the codec's own `tool-approval-request` output event. It carries `call_id` and `name` in headers and the arguments JSON in the message body, so a client can render the approval prompt without waiting for the streamed `function_call`.

The OpenAI codec has **no** `tool-output-denied` output event (unlike Vercel). A denial is resolved entirely client-side: the client sends `tool-approval-response` with `approved: false`, and the reducer authors the terminal state from it (see below). There is no separate agent-published denied event.

## How the reducer models tool state

OpenAI's item model is the crux of the design. Every item the codec stores must be a valid `Responses.ResponseInputItem`, because `toResponsesInput` feeds the stored items straight back to the model as next-turn input. But a `ResponseInputItem.FunctionCallOutput` has no field for an _approval decision_ and no field for an _error_: its `output` is just a string (or a content-item list). So the codec splits tool state in two:

- **What the model round-trips** — a `function_call_output` item, held in `message.items` like any other item.
- **What only a renderer needs** — the approval decision (`pending` / `approved` / `denied`), the result status (`ok` / `failed`), and the gated tool's name/arguments. This is `OpenAIToolCallState`, held per `call_id` in a map _off_ the item array, on the reducer's `MessageEntry.toolStates`.

`getMessages` surfaces the map as an optional `OpenAIMessage.toolCallStates` field (a `Record<call_id, OpenAIToolCallState>`), emitted only when the message recorded some tool state — so an ordinary message is unchanged. `toResponsesInput` reads only `items`, so the tool-state field never affects model input, and the `OpenAIItem → ResponseInputItem` invariant holds.

The fold arms:

| Event                              | Item effect                                                                                                      | Tool-state effect                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `tool-approval-request` (output)   | none                                                                                                             | `approval: 'pending'` + name + arguments   |
| `tool-approval-response`, approved | none (the result arrives later on its own `tool-result`)                                                         | `approval: 'approved'` (+ optional reason) |
| `tool-approval-response`, denied   | upsert a rejection `function_call_output` (client `reason`, or the default `"Tool execution was not approved."`) | `approval: 'denied'` (+ optional reason)   |
| `tool-result`                      | upsert `function_call_output` with the client's `output`                                                         | `result: 'ok'`                             |
| `tool-result-error`                | upsert `function_call_output` with the failure `message` as its output text                                      | `result: 'failed'`                         |

Because `function_call_output` has no error channel, a client failure surfaces two ways: the human-readable message becomes the output text (so the model sees it next turn), and `toolCallStates[call_id].result` is `'failed'` so a renderer can style it as an error rather than a normal result.

All three client folds **upsert by `call_id`** (find-or-replace within the addressed message), so two conflicting resolutions for one call never leave two outputs and break the `/responses` round-trip — last write wins, in serial order. Approval status and result status are independent, so `OpenAIToolCallState` merges across folds rather than overwriting.

### Routing and mid-stream joins

Every tool fold routes by codec-message-id (the reducer never scans items for the call), so it lands on the message its own input/output names. A `tool-approval-request` on a mid-stream join can create a `MessageEntry` that holds only `toolStates` — its gated `function_call` hasn't paged in yet. Such an entry surfaces as a no-item message with a populated `toolCallStates`; it round-trips safely because `toResponsesInput` reads only `items`, so it contributes nothing to the model input until the call pages in.

## Ergonomic helpers

The entry point ships framework-agnostic helpers alongside the codec, so an
application driving an agent loop does not reimplement the glue. All read only
`OpenAIMessage[]` / codec public types — no transport internals, no application
policy (which tools are client-executed or gated stays with the app).

- **Model-input conversion** — `toResponsesInput(messages)` flattens the stored
  `OpenAIMessage[]` into the `/responses` `input` array by concatenating each
  message's `items`.
- **Loop correlation** — `resolvedCallIds(messages)` returns the `call_id`s whose
  `function_call_output` has folded, and `approvedUnexecutedCalls(messages)` (built
  on it) returns the gated calls a user approved but the agent has not yet run —
  the calls the loop executes server-side on resume before the next model turn.

Rendering is left to the application, since a display projection bakes in
rendering decisions (what counts as a part, how reasoning is joined, which items
to drop) that a given UI makes for itself. The OpenAI demo shows one approach:
its `src/app/display.ts` walks a message's `items` into ordered display parts,
pairing each `function_call` with its `function_call_output` and out-of-band
`toolCallState` by `call_id` across sibling messages.

## Code references

Key files:

- `src/openai/codec/descriptors.ts` — output and input descriptor tables; the tool surface (`function_call_arguments`, `function_call_output`, `tool-approval-request`, and the three tool inputs) and the "not described → throw" inventory of unsupported events.
- `src/openai/codec/events.ts` — `OpenAIInput` (user-message, regenerate, and the three tool variants), the tool payload types, `OpenAIToolCallState`, and `ToolApprovalRequestEvent`.
- `src/openai/codec/reducer.ts` — the tool folds (`foldToolResult`, `foldToolResultError`, `foldToolApprovalResponse`, and the `tool-approval-request` output arm), `MessageEntry.toolStates`, and the `toolCallStates` surfacing in `getMessages`.
- `src/openai/codec/fields.ts` — the shared header-field bindings for the tool descriptors (`fCallId`, `fName`, `fApproved`, `fReason`).
- `src/openai/codec/index.ts` — `ResponsesCodec`, the full `factories` selector.
- `src/openai/to-responses-input.ts` — `toResponsesInput`, flattening stored messages into `/responses` input.
- `src/openai/correlation.ts` — the loop correlation readers: `resolvedCallIds`, `approvedUnexecutedCalls`.
- `src/openai/index.ts` — the entry point re-exporting the codec and the helpers above.
- `src/core/codec/well-known-inputs.ts` — the five well-known factories and the `TInput`-gated typing that makes the tool factories optional.

## Related documentation

- [Tool calling](../features/tool-calling.md) — the feature, including the server / client execution split and suspend/resume.
- [Vercel codec](vercel-codec.md) — the other fully worked codec, with the same tool and approval surface expressed against Vercel's wire types.
- [Codec interface](codec-interface.md) — the `Codec` contract, `defineCodec`, and the full-vs-partial codec distinction.
