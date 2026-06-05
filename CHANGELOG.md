# Change log

This contains only the most important and/or user-facing changes; for a full changelog, see the commit history.

## [0.2.0](https://github.com/ably/ably-ai-transport-js/tree/0.2.0) (2026-06-08)

[Full Changelog](https://github.com/ably/ably-ai-transport-js/compare/0.1.0...0.2.0)

This release reshapes the SDK's public surface around two core renames: the transport/turn vocabulary becomes session/run, and the codec becomes an event-sourced `(init, fold)` reducer over a Run-keyed conversation tree. It also realigns the on-the-wire message names and headers, and adds a suspend/resume run lifecycle. The toolchain moves to pnpm and Node 20 is dropped.

### Breaking Changes

- Renamed the core entities `Transport` → `Session` and `Turn` → `Run` across the whole API: `createClientTransport` → `createClientSession`, `createServerTransport` → `createAgentSession`, `ClientTransport` → `ClientSession`, `ServerTransport` → `AgentSession` (and their `*Options`), `ActiveTurn` → `ActiveRun`, `TurnEndReason` → `RunEndReason`, `TurnLifecycleEvent` → `RunLifecycleEvent`, `newTurn` → `createRun`, and `Turn.streamResponse` → `Run.pipe`. `waitForTurn` was removed entirely. Both sessions now expose `connect()`, and a new `Invocation` value object carries run identity between client and agent. [#78](https://github.com/ably/ably-ai-transport-js/pull/78)
- `createClientSession`/`createAgentSession` now take `{ client, channelName }` and resolve the channel themselves instead of a pre-resolved `channel`; the React providers read the Ably client from the surrounding `<AblyProvider>`. [#89](https://github.com/ably/ably-ai-transport-js/pull/89)
- The codec contract is now an event-sourced `(init, fold)` reducer (`Reducer`/`ReducerMeta`) over an opaque per-Run projection, with separate `TInput`/`TOutput` event types. `Codec` and `ClientSession` are generic over `<TInput, TOutput, TProjection, TMessage>` (`AgentSession` over `<TOutput, TProjection, TMessage>`, `View` over `<TInput, TMessage>`); the encoder exposes `publishInput`/`publishOutput` and `Decoder.decode` returns `{ inputs, outputs }`. The old `MessageAccumulator`, `DiscreteEncoder`, `StreamEncoder`, `StreamDecoder`, `DecoderOutput`, and `eventOutput` exports are replaced by `Encoder`/`Decoder`/`Reducer`/`ReducerMeta`. [#92](https://github.com/ably/ably-ai-transport-js/pull/92) [#130](https://github.com/ably/ably-ai-transport-js/pull/130)
- Removed the Vercel server-side tool-approval and tool-event helper suite that 0.1.0 introduced (`applyToolApprovalsToHistory`, `prepareApprovalTurn`, `extractApprovalDecisionsFromHistory`, `streamResponseWithApprovalRedirect`, `applyToolEventsToHistory`, the `useStagedAddToolApprovalResponse` hook, and their types). Tool results and approvals now flow through the codec reducer, keyed by `toolCallId`. [#92](https://github.com/ably/ably-ai-transport-js/pull/92)
- Made the core domain-independent: `Codec.getMessages(projection)`, `View.getMessages()`, and `useView`'s `ViewHandle.messages` all return `CodecMessage<TMessage>[]` (each message paired with its codec-message-id) instead of bare `TMessage`, with `CodecMessage` exported from every entry point. Reconstructed `UIMessage.id` now preserves the source/stream id rather than the wire codec-message-id, so code that correlated on `message.id === codec-message-id` must read the pair. [#162](https://github.com/ably/ably-ai-transport-js/pull/162) [#173](https://github.com/ably/ably-ai-transport-js/pull/173)
- Reworked the `View` branch-navigation surface: `select()` / `getSelectedIndex()` / `getSiblings()` (keyed on a message id) become `view.branchSelection(codecMessageId)` (returns a `BranchSelection` bundle) and `view.selectSibling(codecMessageId, index)`, and projection-free `RunInfo` snapshots are added (`view.runs()`, `runOf()`, `run()`, each carrying a run's lifecycle `status`). `View`'s first generic is now `TInput` (`View<TInput, TMessage>`). [#135](https://github.com/ably/ably-ai-transport-js/pull/135) [#162](https://github.com/ably/ably-ai-transport-js/pull/162)
- The conversation tree is now keyed by Run and node rather than by message: `Tree<TMessage>` → `Tree<TOutput, TProjection>`. Node lookups change from `getNode()` / `getSiblings()` (which returned messages) to `getRunNode()` / `getNodeByCodecMessageId()` / `getSiblingNodes()`; the message-keyed `turn` event (`TurnLifecycleEvent`) becomes a Run-keyed `run` event (`RunLifecycleEvent`, now carrying `serial` and `invocationId`); and a new typed `output` event (`OutputEvent`) streams decoded agent outputs. [#102](https://github.com/ably/ably-ai-transport-js/pull/102) [#144](https://github.com/ably/ably-ai-transport-js/pull/144) [#145](https://github.com/ably/ably-ai-transport-js/pull/145)
- The agent now mints run and invocation identity: `ActiveRun.runId` is a `Promise<string>` (await it for the agent-minted id) and the synchronous routing handle is `ActiveRun.inputCodecMessageId`; `ActiveRun` no longer exposes a `stream` (streaming is now a consumer-layer concern). The agent assigns one `invocationId` per HTTP request, exposed synchronously as `Run.invocationId`. [#155](https://github.com/ably/ably-ai-transport-js/pull/155) [#161](https://github.com/ably/ably-ai-transport-js/pull/161) [#167](https://github.com/ably/ably-ai-transport-js/pull/167)
- Standardised cancellation on "cancel" and scoped it per-run: `Codec.abort()` → `Codec.cancel()`, the run-runtime callback `onAbort` → `onCancelled`, the wire stream-status value `'aborted'` → `'cancelled'`, and `EVENT_ABORT` removed; `ClientSession.cancel(runId)` now takes a plain `runId` (the `{ own: true }` default is gone), `close()` takes no arguments (`CloseOptions` removed), and `CancelFilter` / `HEADER_CANCEL_*` are no longer exported. [#109](https://github.com/ably/ably-ai-transport-js/pull/109) [#117](https://github.com/ably/ably-ai-transport-js/pull/117)
- `ClientSession.close()` and `AgentSession.close()` now detach the channel the session attached, and `AgentSession.close()` is now async (returns `Promise<void>`). [#168](https://github.com/ably/ably-ai-transport-js/pull/168)
- Added a suspend/resume run lifecycle. The conversation unit is a Run, published via `ai-run-start` / `ai-run-suspend` / `ai-run-resume` / `ai-run-end` (replacing 0.1.0's `x-ably-turn-start` / `x-ably-turn-end`); a run-end is terminal, and a run awaiting participant input suspends and is later resumed under the same id. Agents call `Run.suspend()` and `Run.end(reason)`, where `RunEndReason` is `'complete' | 'cancelled' | 'error'`. The Vercel adapter adds `vercelRunOutcome` (returns `RunEndReason | 'suspend'`). [#152](https://github.com/ably/ably-ai-transport-js/pull/152) [#153](https://github.com/ably/ably-ai-transport-js/pull/153)
- The `RunLifecycleEvent.type` discriminator (from `tree.on('run')` / `view.on('run')`) is decoupled from the wire names: switch on `'start'` / `'suspend'` / `'resume'` / `'end'`, not the `ai-run-*` message names. [#98](https://github.com/ably/ably-ai-transport-js/pull/98) [#147](https://github.com/ably/ably-ai-transport-js/pull/147)
- Realigned the on-the-wire message format: Vercel-codec publishes ride two message names, `ai-input` (client) and `ai-output` (agent), with the codec event type carried in a `type` header rather than the Ably message name; the stream-close status value changed `"finished"` → `"complete"`; the message-identity header `x-ably-msg-id` became `codec-message-id` (and the per-event id is now `event-id`), with the `x-ably-` prefix dropped as headers moved into the `extras.ai` tiers; and client tool results now publish as `tool-result` / `tool-result-error` inputs on `ai-input` instead of being staged into the invocation POST body. [#107](https://github.com/ably/ably-ai-transport-js/pull/107) [#115](https://github.com/ably/ably-ai-transport-js/pull/115) [#128](https://github.com/ably/ably-ai-transport-js/pull/128) [#130](https://github.com/ably/ably-ai-transport-js/pull/130)
- Moved all SDK wire metadata out of `extras.headers` into a reserved `extras.ai` namespace (split into `extras.ai.transport` / `extras.ai.codec`), freeing `extras.headers` for application use. `getHeaders` is replaced by `getCodecHeaders` / `getTransportHeaders`, the `x-ably-` / `x-domain-` header prefixes and `DOMAIN_HEADER_PREFIX` / `CODEC_HEADER_PREFIX` are gone, and payloads expose `codecHeaders` / `transportHeaders`. [#132](https://github.com/ably/ably-ai-transport-js/pull/132)
- Surfaced agent errors through `ai-run-end` (carrying `run-reason: error` plus `error-code` / `error-message` headers) instead of a dedicated `ai-error` event; the `EVENT_ERROR` / `ai-error` export was removed and pre-run-start failures now surface via the HTTP error path. [#105](https://github.com/ably/ably-ai-transport-js/pull/105)
- The agent now reconstructs the full conversation from the channel, so the invocation HTTP body carries only identifiers (an input pointer) instead of per-message metadata and history. [#99](https://github.com/ably/ably-ai-transport-js/pull/99) [#108](https://github.com/ably/ably-ai-transport-js/pull/108)
- Removed `Run.addMessages` (the server-relay method) along with `AddMessageOptions` / `AddMessagesResult`. [#157](https://github.com/ably/ably-ai-transport-js/pull/157)
- Renamed the React surface to match Session/Run: `TransportProvider` → `ClientSessionProvider`, `useClientTransport` → `useClientSession`, `createTransportHooks` → `createSessionHooks`, `TransportHooks` → `SessionHooks`, `ClientTransportHandle` → `ClientSessionHandle`, `TransportSlot` → `ClientSessionSlot` (with `.error` → `sessionError`), and `TransportProviderProps` → `ClientSessionProviderProps`. `NearestTransportContext` is no longer exported (a single `ClientSessionContext` now), and the deprecated `EventNode` / `TreeNode` re-exports were removed. [#73](https://github.com/ably/ably-ai-transport-js/pull/73) [#78](https://github.com/ably/ably-ai-transport-js/pull/78)
- Removed the channel-history-derived run-tracking reads `Tree.getActiveTurnIds()` and `View.getActiveTurnIds()`, and the `useActiveTurns` React hook; track outstanding runs via your own `ActiveRun` handles or `tree.on('run', …)`. [#118](https://github.com/ably/ably-ai-transport-js/pull/118)
- Dropped Node 20 from the supported runtimes (Node 22+ is now required). [#121](https://github.com/ably/ably-ai-transport-js/pull/121)

### New Features

- Added an `inputClientId` (`input-client-id` transport header) identity tier that the agent stamps on every event it publishes, so observers can attribute agent output to whichever client published the triggering input (e.g. a tool result from a different client). [#116](https://github.com/ably/ably-ai-transport-js/pull/116)
- Added `Run.loadConversation()`, which reconstructs the full multi-turn conversation for an agent by walking the parent-run chain from channel history. [#119](https://github.com/ably/ably-ai-transport-js/pull/119)
- Reworked branching around the Run-keyed tree: editing a prompt forks an input node while regenerating continues a run, with message-anchored branch selection and Run-unit history pagination (`View.loadOlder(limit)` counts Runs). [#102](https://github.com/ably/ably-ai-transport-js/pull/102)
- Added an `Ably-Agent` header that identifies SDK usage to Ably, tagged with a `vercel-ai-sdk-ui-message` marker for sessions created via the Vercel entry points. [#160](https://github.com/ably/ably-ai-transport-js/pull/160)
- `useView`'s `ViewHandle` now exposes the `runs()` Run-list snapshot, alongside the existing `runOf()` / `run()`. [#174](https://github.com/ably/ably-ai-transport-js/pull/174)

### Bug Fixes

- Fixed cancel-during-streaming in the Vercel adapter so a Stop click during run-start reaches the agent and resolves to a clean `cancelled` terminal state, instead of leaving the UI stuck and logging a noisy `AbortError`. [#123](https://github.com/ably/ably-ai-transport-js/pull/123)

## [0.1.0](https://github.com/ably/ably-ai-transport-js/tree/0.1.0) (2026-04-23)

[Full Changelog](https://github.com/ably/ably-ai-transport-js/compare/0.0.1...0.1.0)

This release focuses on three themes: a proper React integration story (context-based providers, error surfacing, strict-mode safety), tool-calling support (including server-side tool-approval helpers for the Vercel AI SDK), and a tighter error-handling and channel-resilience surface on both client and server transports.

### Breaking Changes

- Conversation state moved off `ClientTransport` into separate `Tree` and `View` abstractions. Removed `ClientTransport.getMessages()`, `getMessagesWithHeaders()`, `getAblyMessages()`, `getMessageHeaders()`, `getActiveTurnIds()`, `history()`, `getTree()`, and the `on('message' | 'ably-message' | 'turn')` overloads - consumers now read from `transport.tree` and `transport.view`. [#13](https://github.com/ably/ably-ai-transport-js/pull/13)
- `send()`, `regenerate()`, and `edit()` moved from `ClientTransport` to `View`. `select()` and `getSelectedIndex()` moved from `Tree` to `View`. [#27](https://github.com/ably/ably-ai-transport-js/pull/27)
- `useClientTransport` changed from a factory hook to a context reader; channel and transport setup now live inside `TransportProvider`. `useChatTransport` similarly takes `{ channel, clientId }` and returns `{ chatTransport, transport }`. [#34](https://github.com/ably/ably-ai-transport-js/pull/34) [#35](https://github.com/ably/ably-ai-transport-js/pull/35)
- Removed the `useEdit`, `useRegenerate`, `useSend`, `useMessages`, `useHistory`, and `useConversationTree` hooks in favour of `useView` and `useTree`. [#13](https://github.com/ably/ably-ai-transport-js/pull/13) [#62](https://github.com/ably/ably-ai-transport-js/pull/62)
- Type renames: `ConversationTree` → `Tree`, `ConversationNode` → `TreeNode` → `MessageNode` (with an `EventNode` → `EventsNode` counterpart), `View<TMessage>` → `View<TEvent, TMessage>`, `ViewOptions` → `UseViewOptions`, `PaginatedMessages` → `HistoryPage`. `MessageWithHeaders` and `MessageAccumulator` interface are tightened (new required `seedMessages` / `completeSeeded` methods; `MessageNode` / `EventsNode` require a `kind` field). [#13](https://github.com/ably/ably-ai-transport-js/pull/13) [#25](https://github.com/ably/ably-ai-transport-js/pull/25) [#27](https://github.com/ably/ably-ai-transport-js/pull/27) [#28](https://github.com/ably/ably-ai-transport-js/pull/28)
- `Codec.getMessageKey()` removed - message identity is now assigned by the transport via `x-ably-msg-id`. [#11](https://github.com/ably/ably-ai-transport-js/pull/11)
- `api` is now required on core `ClientTransportOptions`; the `/api/chat` default only applies via the Vercel layer. [#35](https://github.com/ably/ably-ai-transport-js/pull/35)
- Renamed `SendMessagesRequestContext.id` to `chatId`. [#33](https://github.com/ably/ably-ai-transport-js/pull/33)

### New Features

- Tool-calling support end-to-end over Ably, including cross-turn event publishing via `Turn.addEvents()` (server) and `View.update()` (client) for late-arriving tool results and approval workflows. [#28](https://github.com/ably/ably-ai-transport-js/pull/28)
- Server-side tool-approval helpers for the Vercel AI SDK (`applyToolApprovalsToHistory`, `prepareApprovalTurn`, `extractApprovalDecisionsFromHistory`, `streamResponseWithApprovalRedirect`) plus a per-event `resolveWriteOptions` hook on `streamResponse`. [#69](https://github.com/ably/ably-ai-transport-js/pull/69)
- New `TransportProvider` and `ChatTransportProvider` components; hooks read the transport from context. [#34](https://github.com/ably/ably-ai-transport-js/pull/34) [#61](https://github.com/ably/ably-ai-transport-js/pull/61)
- Multiple independent paginated views over the same tree via `ClientTransport.createView()` and the `useCreateView` hook. [#27](https://github.com/ably/ably-ai-transport-js/pull/27)
- Error state and `onError` callbacks on React hooks, and `useChat` + `ChatTransport` errors now surface via `useChat`'s `error` / `onError` the same way the default SSE transport does. [#32](https://github.com/ably/ably-ai-transport-js/pull/32) [#58](https://github.com/ably/ably-ai-transport-js/pull/58)
- Client and server transports detect channel continuity loss and surface it via the transport error event. [#32](https://github.com/ably/ably-ai-transport-js/pull/32) [#65](https://github.com/ably/ably-ai-transport-js/pull/65)
- `newTurn` accepts an external `AbortSignal`. [#38](https://github.com/ably/ably-ai-transport-js/pull/38)
- The core UMD bundle is now published to Ably's CDN (`prod-cdn.ably.com`) on each release. [#23](https://github.com/ably/ably-ai-transport-js/pull/23)

### Bug Fixes

- Client-executed tool results and approval flows now work end-to-end via `useChat`; a new message while an approval is pending forks cleanly rather than leaving a dangling tool call. [#64](https://github.com/ably/ably-ai-transport-js/pull/64)
- Schedule transport close as a microtask to survive React strict mode. [#57](https://github.com/ably/ably-ai-transport-js/pull/57)
- Externalise `ably/react` and the JSX runtime in the published bundles. [#56](https://github.com/ably/ably-ai-transport-js/pull/56)
- Guard `View.loadOlder()` against concurrent calls that could corrupt pagination state. [#25](https://github.com/ably/ably-ai-transport-js/pull/25)
- Cache flattened nodes and skip tree walks during streaming to cut View re-renders. [#40](https://github.com/ably/ably-ai-transport-js/pull/40)
- Fix `decodeHistory` re-decoding the entire buffer on each page fetch (O(n²) → O(n)). [#67](https://github.com/ably/ably-ai-transport-js/pull/67)
- Return the real `turn.stream` to `useChat` so abort and backpressure propagate. [#31](https://github.com/ably/ably-ai-transport-js/pull/31)
- Call `clearScope` on the error path in the Vercel decoder. [#29](https://github.com/ably/ably-ai-transport-js/pull/29)

### Improvements

- Unified server-side turn error handling. [#60](https://github.com/ably/ably-ai-transport-js/pull/60)
- Explicit lifecycle state enums for transport and turn. [#52](https://github.com/ably/ably-ai-transport-js/pull/52)
- Compute fork metadata for message edits from `useChat` state. [#37](https://github.com/ably/ably-ai-transport-js/pull/37)

## [0.0.1](https://github.com/ably/ably-ai-transport-js/tree/0.0.1) (2026-03-27)

Initial experimental release of the Ably AI Transport SDK for JavaScript.
