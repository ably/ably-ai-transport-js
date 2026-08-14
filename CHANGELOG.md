# Change log

This contains only the most important and/or user-facing changes; for a full changelog, see the commit history.

## [0.8.0](https://github.com/ably/ably-ai-transport-js/tree/0.8.0) (2026-08-14)

[Full Changelog](https://github.com/ably/ably-ai-transport-js/compare/0.7.0...0.8.0)

This release adds support for **Vercel AI SDK v7**: the `ai` peer range widens to `^6 || ^7`, and v6 keeps working. It also adds a **Temporal integration**, via a [Temporal plugin](https://docs.temporal.io/develop/plugins-guide), that allows you to easily publish and subscribe to a durable session, without hand-writing the run lifecycle: opening a run, suspending it for client input, ending it, and cleaning up when a turn fails. The release also includes a number of other improvements; see the full details below.

### New Features

- **Vercel AI SDK v7 support.** The `ai` peer dependency range widens to `^6 || ^7`. `ChatTransport`, the codec's public types, and the wire format are unchanged across the two majors, so v6 keeps working. [#298](https://github.com/ably/ably-ai-transport-js/pull/298)
- **Temporal plugin.** `createAblyTransportPlugin()` from `@ably/ai-transport/temporal` is a [Temporal plugin](https://docs.temporal.io/develop/plugins-guide) that registers the run-framing activities (`openRun`, `endRun`, `suspendRun`, `cleanupRun`) on a worker. The new `@ably/ai-transport/temporal/workflow` entry point proxies them as `withRun(invocation, body)`. See the [guide](https://github.com/ably/ably-ai-transport-js/tree/main/src/temporal). [#297](https://github.com/ably/ably-ai-transport-js/pull/297)
- **`withAgentSession(options, body)`** scaffolds one unit of durable work: it creates an agent session for an invocation, connects, runs `body`, and detaches on both success and failure - so a run the body leaves open stays adoptable by the next attempt. `@ably/ai-transport/vercel` exports a codec-pre-bound wrapper. [#297](https://github.com/ably/ably-ai-transport-js/pull/297)
- **`pageUntilLocated(run, options)`** pages channel history backwards only until a freshly opened run's trigger event folds in, rather than draining the conversation, so opening a turn costs about one history page whatever the conversation's length. [#297](https://github.com/ably/ably-ai-transport-js/pull/297)

## [0.7.0](https://github.com/ably/ably-ai-transport-js/tree/0.7.0) (2026-07-31)

[Full Changelog](https://github.com/ably/ably-ai-transport-js/compare/0.6.0...0.7.0)

This release adds support for a new codec: the `@ably/ai-transport/openai` entry point ships a codec for the OpenAI Responses streaming API, including client-executed tools and human tool approvals. The core codec output API is also redesigned, so a codec declares its wire shape declaratively. The release also includes a number of other improvements; see the full details below.

### Breaking Changes

- **The core codec output-descriptor API is redesigned.** An output stream now names a `streamId` extractor instead of `idField`, and its `start` / `delta` / `end` phases each group into one spec object; `OutputBuilder.drop` marks an event as curated off the wire, a codec selects the well-known input factories it supports through the new `factories` config, and `decodeLifecycle` becomes `decoderSynthesiseLifecycle`. [#273](https://github.com/ably/ably-ai-transport-js/pull/273)
- **`createRun` and `adoptRun` take a shared, exported `RunIdentity`** (`{ runId, invocationId }`): `createRun(invocation, identity?, hooks?)` mints whichever id you omit, and `adoptRun(invocation, identity, hooks?)` requires both. `RunRuntime` is renamed `RunHooks` and no longer carries run ids, `AdoptIdentity` is removed with its `triggerEventId` moving onto the `Invocation` argument, and an empty-string id now throws `InvalidArgument` instead of minting a new one. [#286](https://github.com/ably/ably-ai-transport-js/pull/286)
- `PipeOptions` is removed: `Run.pipe` and `RunStep.pipe` no longer take a second options argument. [#282](https://github.com/ably/ably-ai-transport-js/pull/282)
- The pre-publish `onMessage` hooks - on a run's hooks object and on `EncoderOptions` - are renamed `onAblyMessage`. [#281](https://github.com/ably/ably-ai-transport-js/pull/281)
- A step attempt's serial is renamed to `step-start-serial` on the wire, and with it `OutputEvent.stepStartSerial` and `buildTransportHeaders`'s `stepStartSerial` option. `RunNode.startSerial` (run ordering) is unchanged. [#283](https://github.com/ably/ably-ai-transport-js/pull/283)

### New Features

- **New `@ably/ai-transport/openai` entry point.** `ResponsesCodec` streams OpenAI Responses output - assistant text, refusals, reasoning, and function-call arguments - and `toResponsesInput` flattens a drained `run.view` into the `input` array for a `/v1/responses` call. Adds an optional `openai` peer dependency. [#274](https://github.com/ably/ably-ai-transport-js/pull/274)
- **Client-side tools and approvals in the OpenAI codec.** `OpenAIInput` gains `ToolResult`, `ToolResultError`, and `ToolApprovalResponse` variants keyed by `call_id`, which turn on the matching `create*` factories, and a codec-authored `tool-approval-request` output event gates a function call on a human decision. The `unansweredCalls`, `approvedUnexecutedCalls`, and `resolvedCallIds` readers let an agent loop partition a turn's calls. [#278](https://github.com/ably/ably-ai-transport-js/pull/278)
- `Run.pipe` and `RunStep.pipe` accept any `AsyncIterable<TOutput>` as well as a `ReadableStream`, via the new `PipeSource` union, so a provider stream that is already async-iterable can be piped straight in. [#274](https://github.com/ably/ably-ai-transport-js/pull/274)

### Bug Fixes

- **A client tool-result continuation now forks its own reply run** instead of re-entering the suspended run, so two clients answering the same tool call no longer overwrite each other's result or cross-contaminate the next prompt. The fork stamps `supersedes` and the suspended run is hidden from branch selection, so a single client's response still renders as one linear reply; raw `view.send` callers get `createToolResultFork` from `@ably/ai-transport/vercel`. [#271](https://github.com/ably/ably-ai-transport-js/pull/271)
- `useView` re-renders its consumers when a run's status changes, including suspend and resume, so UI derived from a run's `status` no longer stays stuck in the streaming state after the run ends. [#284](https://github.com/ably/ably-ai-transport-js/pull/284)

## [0.6.0](https://github.com/ably/ably-ai-transport-js/tree/0.6.0) (2026-07-21)

[Full Changelog](https://github.com/ably/ably-ai-transport-js/compare/0.5.0...0.6.0)

This release adds **mid-run steering**: a client can steer an already-active run with a follow-up prompt via `run.steer()`, without cancelling the run or breaking the stream. The release also includes a number of other improvements; see the full details below.

### Breaking Changes

- The `UIMessageCodec` value export is replaced by the `createUIMessageCodec()` factory. [#267](https://github.com/ably/ably-ai-transport-js/pull/267)

### New Features

- **Mid-run steering.** `run.steer(input)` publishes a follow-up user message into an active run and returns `{ published, outcome }`; on the agent side, `run.hasInput()` drives the inference loop and the optional `onSteer` hook fires when a steer folds in. Adds the `SteerOutcome` and `SteerResult` types. [#260](https://github.com/ably/ably-ai-transport-js/pull/260)
- **The Vercel wrapper forwards the AI SDK `UIMessage` generic type parameters** `<Metadata, DataParts, Tools>` through `createClientSession`, `createAgentSession`, `createChatTransport`, and the imperative React hooks. `ChatTransport` now extends the SDK's `AI.ChatTransport`. [#267](https://github.com/ably/ably-ai-transport-js/pull/267)

### Bug Fixes

- A failed initial attach no longer permanently breaks a session; the next `connect()` retries against a channel that may have recovered. [#252](https://github.com/ably/ably-ai-transport-js/pull/252)
- Errors carry more accurate codes: cancellations now surface `OperationCancelled`, closed-session operations `SessionClosed`, and internal failures a new `InternalError`, rather than all being `InvalidArgument`. [#259](https://github.com/ably/ably-ai-transport-js/pull/259)

## [0.5.0](https://github.com/ably/ably-ai-transport-js/tree/0.5.0) (2026-07-09)

[Full Changelog](https://github.com/ably/ably-ai-transport-js/compare/0.4.0...0.5.0)

This release adds first-class support for running AI Transport agents inside durable execution frameworks: workflow engines such as Temporal and Vercel's Workflow Development Kit (WDK) that run each turn as a set of short-lived, independently retried processes. The new `Step` primitive is the re-attemptable unit of output within a run. A retry under the same step id supersedes the failed attempt's output on the channel instead of appending a duplicate, and a fresh process can adopt an already-open run and continue it without re-opening, so a single run (and its steps) is safe to execute across process boundaries and workflow retries. See the runnable [Temporal](https://github.com/ably/ably-ai-transport-js/tree/main/demo/temporal/use-client-session-temporal) and [Vercel WDK](https://github.com/ably/ably-ai-transport-js/tree/main/demo/vercel/react/use-chat-wdk) reference demos. The release also includes a number of other improvements; see the full details below.

### Breaking Changes

- **`AgentSession.close()` is renamed to `AgentSession.detach()`, and a new `AgentSession.end()` is added.** `detach()` aborts in-flight runs and detaches the channel the session attached, leaving any open run resumable; `end()` first publishes a terminal `ai-run-end` for a still-open run (so a forgotten `run.end()` still closes every observer) and then detaches. Neither closes the injected Ably client. Replace `session.close()` with `session.detach()`, or with `session.end()` where the session owns the run's terminal. [#233](https://github.com/ably/ably-ai-transport-js/pull/233)

### New Features

- **Steps: a re-attemptable unit of output within a run.** `run.createStep(options?)` returns a `RunStep` handle whose lifecycle mirrors the run (`start()`, then `pipe()` or `send()`, then `end()`); a retry under the same step id supersedes the failed attempt's channel output rather than appending a duplicate. `run.pipe()` keeps its signature but now brackets its output in a lazy implicit step, and a run's steps are exposed on the read-only `View`. [#232](https://github.com/ably/ably-ai-transport-js/pull/232)
- **Durable cross-process run execution.** `AgentSession.adoptRun(identity, { durable })` returns an `AdoptedRun`; `await run.load()` resolves the run's anchors from the channel so a fresh process continues an already-open run without republishing `ai-run-start`. Step identity is stable and idempotent across at-least-once retries, so a re-run supersedes a dead attempt's output instead of doubling it. [#233](https://github.com/ably/ably-ai-transport-js/pull/233)
- **Ergonomics for hosts that drive their own agent loop** (one where the host owns each model call and tool execution as its own durable step): `RunStep.send(output)` publishes a single discrete output message rather than streaming through `pipe()`; `stripToolExecutes`, `pendingToolCalls`, and `approvedPendingToolCalls` help a driver run tools out of band; and a new `@ably/ai-transport/temporal` entry point ships a `stepIdFor` helper for deriving stable step ids. [#249](https://github.com/ably/ably-ai-transport-js/pull/249)

### Bug Fixes

- The Vercel codec now preserves a tool part's representation through an encode/decode/fold roundtrip: a statically declared `tool-<name>` part no longer comes back as `dynamic-tool`, so clients that switch on the part type render it correctly. [#242](https://github.com/ably/ably-ai-transport-js/pull/242)
- A retired invocation's late `ai-run-suspend` no longer rolls a taken-over run back to suspended, so a durable continuation (a follow-up process calling `run.load()`) no longer stalls with a "run is suspended" rejection. [#248](https://github.com/ably/ably-ai-transport-js/pull/248)
- A channel that reaches FAILED, SUSPENDED, or DETACHED before its first attach no longer emits a spurious `ChannelContinuityLost` session error; continuity loss is reported only after the channel has attached at least once. [#230](https://github.com/ably/ably-ai-transport-js/pull/230)
- History pagination validates that the requested limit is a positive integer, and the transport stops retaining wires it has already served. [#212](https://github.com/ably/ably-ai-transport-js/pull/212)

### Performance

- `View.loadOlder()` reveals are now O(revealed) rather than O(window), via per-node flatten memoisation, so paging deep history stays cheap. [#241](https://github.com/ably/ably-ai-transport-js/pull/241)

## [0.4.0](https://github.com/ably/ably-ai-transport-js/tree/0.4.0) (2026-07-01)

[Full Changelog](https://github.com/ably/ably-ai-transport-js/compare/0.3.0...0.4.0)

This release introduces external data hydration: an app that owns its message store can seed a conversation from it and reconcile only the unstored tail off the Ably channel, instead of replaying the whole history. The new `View.loadUntil()` pages back to the newest message you already hold and returns just the missing tail, so you compose `[...stored, ...tail]` with no duplicates. See the [external hydration demo](https://github.com/ably/ably-ai-transport-js/tree/main/demo/vercel/react/use-chat-db). The release also includes a number of other improvements; see the full details below.

### Breaking Changes

- **The agent's `run.messages` now returns only the messages belonging to the run, rather than all messages for the full conversation.** In order to obtain the full set of messages for the conversation (for example, in order to pass it as input to the LLM) drain the `run.view` and access `run.view.getMessages()`:

  ```ts
  // before (0.3.0): run.messages held the whole conversation after loadConversation()
  await run.loadConversation();
  const messages = run.messages;

  // after (0.4.0): drain run.view, then read it
  while (run.view.hasOlder()) await run.view.loadOlder();
  const messages = run.view.getMessages().map((m) => m.message);
  ```

  [#223](https://github.com/ably/ably-ai-transport-js/pull/223) [#227](https://github.com/ably/ably-ai-transport-js/pull/227) [#243](https://github.com/ably/ably-ai-transport-js/pull/243)

- Renamed the run types onto a shared read-model: client `ActiveRun` → `ClientRun<TMessage>`, agent `Run` → `AgentRun` (both expose `runId`, `status`, `error`, `messages`). [#223](https://github.com/ably/ably-ai-transport-js/pull/223)
- `ClientRun.runId` is now a synchronous `string` (was `Promise<string>`); `await run.started` before reading it. The agent's `runId` is unchanged. [#223](https://github.com/ably/ably-ai-transport-js/pull/223)
- `ClientView.send` / `regenerate` / `edit` now resolve to `Promise<ClientRun<TMessage>>`. [#223](https://github.com/ably/ably-ai-transport-js/pull/223)
- Removed the agent's `loadConversation()` (with `LoadConversationOptions` / `maxRuns`); drain `run.view` instead, and `run.start()` now awaits the new `run.located`. [#227](https://github.com/ably/ably-ai-transport-js/pull/227)
- `View<TMessage>` is now read-only; sibling navigation and the write path move to `ClientView<TInput, TMessage>` (extends `View`). `session.view` / `createClientView()` already return `ClientView`, so only code naming the old `View<TInput, TMessage>` needs updating. [#220](https://github.com/ably/ably-ai-transport-js/pull/220)
- Renamed `BranchSelection` → `BranchHandle` and removed `selectSibling`; select via `branchSelection(codecMessageId).select(index)`. [#219](https://github.com/ably/ably-ai-transport-js/pull/219)
- Removed the agent's `RunView`; `run.view` is now a read-only `View<TMessage>` (read `run.view.getMessages()`), and `MessageNode` is no longer exported. [#221](https://github.com/ably/ably-ai-transport-js/pull/221)
- `ClientView.send` / `edit` now reject a send with more than one new message (`InvalidArgument`); the array form stays for the wire-only inputs that resolve one turn (e.g. parallel tool results). [#213](https://github.com/ably/ably-ai-transport-js/pull/213)
- Removed `ClientRun.optimisticCodecMessageIds`; read `ClientRun.inputCodecMessageId`. [#213](https://github.com/ably/ably-ai-transport-js/pull/213)
- Removed the `ClientSessionOptions.messages` seed; compose `[...stored, ...live]` yourself over the `loadOlder()` walk. [#227](https://github.com/ably/ably-ai-transport-js/pull/227)
- Removed `AgentSessionOptions.inputEventLookupTimeoutMs` and the `InputEventNotFound` error code; `run.located` has no deadline, so race your own timeout. [#227](https://github.com/ably/ably-ai-transport-js/pull/227)
- Removed `AgentSessionOptions.onError`; subscribe via `session.on('error', ...)`. [#223](https://github.com/ably/ably-ai-transport-js/pull/223)

### New Features

- `View.loadUntil(predicate)` pages history back to the first message your store already holds (the seam) and returns only the messages newer than it, so you hydrate from your own store and reconcile just the unstored tail. [#234](https://github.com/ably/ably-ai-transport-js/pull/234)
- React seed hooks for that recipe: `useMessagesWithSeed` (generic and Vercel) and a `messages` seed option on `useMessageSync`, which compose your stored prefix with the live channel and run the seam walk for you. [#229](https://github.com/ably/ably-ai-transport-js/pull/229)
- `View.loadOlder()` returns the page it revealed (`CodecMessage[]`, oldest-first; `[]` when exhausted), the building block for the seam walk. [#226](https://github.com/ably/ably-ai-transport-js/pull/226)
- Added `historyPageSize` (`ClientSessionOptions` / `AgentSessionOptions`, default 100) to tune the history fetch size per round trip. [#226](https://github.com/ably/ably-ai-transport-js/pull/226)
- The agent gains a real paginating, read-only `run.view` over the same `View` base as the client, replacing its old messages-only read. [#221](https://github.com/ably/ably-ai-transport-js/pull/221)

### Bug Fixes

- The agent no longer feeds incomplete ancestor runs (still streaming, suspended, cancelled, or errored) into the model prompt, so a dangling tool call from a concurrent or interrupted turn no longer makes the provider reject the request. [#237](https://github.com/ably/ably-ai-transport-js/pull/237)
- Fixed a stale message left at the end of the conversation after regenerating a non-head message in a multi-message reply. [#215](https://github.com/ably/ably-ai-transport-js/pull/215)
- Vercel: two tabs sharing a `clientId` no longer error with "inputs array is empty"; a tab with no new inputs waits for the other tab's run and repaints when it completes. [#224](https://github.com/ably/ably-ai-transport-js/pull/224)
- Fixed sends intermittently failing with `unable to send; channel is initialized` after a rapid subscribe/unsubscribe cycle (e.g. React StrictMode in development); `connect()` now attaches the channel explicitly. [#229](https://github.com/ably/ably-ai-transport-js/pull/229)

## [0.3.0](https://github.com/ably/ably-ai-transport-js/tree/0.3.0) (2026-06-19)

[Full Changelog](https://github.com/ably/ably-ai-transport-js/compare/0.2.0...0.3.0)

This release opens up Ably Pub/Sub features on AI sessions: Presence and LiveObjects now pass through to the session's channel alongside the AI stream. It also reworks codec authoring into a declarative `defineCodec` API backed by transport-owned event ordering, changes history pagination to count messages rather than Runs, raises the minimum `ably` version to 2.23.0, and completes agent run-error propagation to clients.

### Breaking Changes

- Raised the minimum `ably` peer dependency from `^2.21.0` to `^2.23.0`. [#202](https://github.com/ably/ably-ai-transport-js/pull/202)
- Removed `clientId` from the `createClientSession` / `createAgentSession` options; sessions now read the client id from the Ably client you pass in. [#188](https://github.com/ably/ably-ai-transport-js/pull/188)
- `View.loadOlder(limit)` (and the `useView` `limit`) now reveals exactly `limit` codec-messages, partially revealing a Run at the page boundary, instead of counting `limit` Runs; the `View.loadOlder` / `hasOlder` contract changes to match. [#201](https://github.com/ably/ably-ai-transport-js/pull/201)
- Reworked the codec authoring surface into a declarative `defineCodec` API: added `defineCodec`, the `boolField` / `enumField` / `jsonField` / `strField` header-field helpers, and the descriptor and builder types (`InputDescriptor`, `OutputDescriptor`, `DefineCodecConfig`, and related), and moved event ordering, de-duplication, and replay into the transport so custom reducers no longer de-dupe against a stream-wide serial high-water-mark. [#184](https://github.com/ably/ably-ai-transport-js/pull/184) [#192](https://github.com/ably/ably-ai-transport-js/pull/192)
- Removed unused public exports: the never-called cross-run event API (`Run.addEvents` and the `EventsNode` node type) and the `headerReader` / `headerWriter` / `DomainHeaderReader` / `DomainHeaderWriter` header utilities. [#177](https://github.com/ably/ably-ai-transport-js/pull/177) [#195](https://github.com/ably/ably-ai-transport-js/pull/195)

### New Features

- Pub/Sub Presence passthrough: sessions now expose the Ably Presence API, and the React session providers implicitly mount a `<ChannelProvider>` so ably-js's `usePresence` hook works against the session's channel. [#151](https://github.com/ably/ably-ai-transport-js/pull/151)
- LiveObjects passthrough: sessions now expose the Ably LiveObjects API, and you can set explicit channel modes (merged with the session defaults) via the new `OBJECT_MODES` export. [#182](https://github.com/ably/ably-ai-transport-js/pull/182)
- Agent run errors now carry their cause to clients via `ai-run-end` (`error-code` / `error-message`), instead of collapsing to a generic "agent reported an error". [#181](https://github.com/ably/ably-ai-transport-js/pull/181)

### Bug Fixes

- Fixed regenerating the follow-up text of a tool-call reply: it previously corrupted the reconstructed conversation (which then ended with an assistant message the model rejects) and rendered an orphan third bubble; the regenerated text now replaces the original in place with its own branch counter. [#189](https://github.com/ably/ably-ai-transport-js/pull/189)
- Fixed late-delivered or reordered events being silently dropped: the transport now keeps a per-node event log and folds each node in canonical serial order with a version high-water-mark, so cross-publisher reordering and out-of-order history pages converge correctly. [#192](https://github.com/ably/ably-ai-transport-js/pull/192)

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
- Surfaced agent errors through `ai-run-end` (`run-reason: error`, with reserved `error-code` / `error-message` header slots) instead of a dedicated `ai-error` event; the `EVENT_ERROR` / `ai-error` export was removed and pre-run-start failures now surface via the HTTP error path. [#105](https://github.com/ably/ably-ai-transport-js/pull/105)
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
