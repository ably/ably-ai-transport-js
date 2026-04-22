# Change log

This contains only the most important and/or user-facing changes; for a full changelog, see the commit history.

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
