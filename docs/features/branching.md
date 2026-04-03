# Conversation branching

AI Transport stores conversation history as a tree, not a linear array. When a user regenerates an assistant response or edits a user message, the transport creates a fork - the original message and its replacement are siblings in the tree, and the user can navigate between them.

Without tree-based history, regeneration and editing destroy the original response. With branching, every version is preserved and navigable.

## How it works

Every message in the tree has:

- **`msgId`** - unique identifier (stamped as `x-ably-msg-id`)
- **`parentId`** - the preceding message in the thread (`x-ably-parent`)
- **`forkOf`** - the message this one replaces (`x-ably-fork-of`), if it's a fork

When you regenerate or edit, the transport sets `forkOf` to the original message's ID. Messages that share the same `parentId` and fork the same original are **siblings** - alternatives at the same point in the conversation.

```
User: "What is Rust?"                     (msg-1, parent: null)
  ├── Assistant: "Rust is a language..."   (msg-2, parent: msg-1)
  └── Assistant: "Rust is a systems..."    (msg-3, parent: msg-1, forkOf: msg-2)  ← regenerated
```

`flattenNodes()` returns the linear message list along the currently selected branch. The user navigates between siblings to switch branches.

## Regenerate

Regeneration forks an assistant message - the server produces a new response for the same prompt:

```typescript
import { useView } from '@ably/ai-transport/react';

const { regenerate } = useView(transport);

// Fork the assistant message - starts a new turn with no new user messages.
// nodeId is the x-ably-msg-id (see treeMsgId helper in the quickstart).
await regenerate(nodeId);
```

The transport automatically computes `forkOf` (the assistant message being replaced) and `parent` (the message before it). The server receives these in the POST body and passes them to `newTurn`.

## Edit

Editing forks a user message - the user provides replacement content, and the server produces a new response:

```typescript
import { useView } from '@ably/ai-transport/react';

const { edit } = useView(transport);

const newMessage = {
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text: 'What is Go?' }],
  createdAt: new Date(),
};

// Fork the user message with new content.
// nodeId is the x-ably-msg-id (see treeMsgId helper in the quickstart).
await edit(nodeId, [newMessage]);
```

## Branch navigation

`useView` provides branch navigation alongside message state:

```typescript
import { useView } from '@ably/ai-transport/react';

const view = useView(transport);

// view.hasSiblings(nodeId) - does this message have alternatives?
// view.getSiblings(nodeId) - all alternatives at this fork point
// view.getSelectedIndex(nodeId) - which sibling is currently selected
// view.select(nodeId, index) - switch to a different sibling
// view.getNode(nodeId) - look up a node by msgId
//
// nodeId is the msgId on each TreeNode — iterate view.nodes:
//   view.nodes.map((node) => {
//     const nodeId = node.msgId;
//   });
```

Build a sibling navigator (where `nodeId` is the resolved `x-ably-msg-id` for the message):

```typescript
{view.hasSiblings(nodeId) && (
  <div>
    <button
      onClick={() => view.select(nodeId, view.getSelectedIndex(nodeId) - 1)}
      disabled={view.getSelectedIndex(nodeId) === 0}
    >
      ←
    </button>
    <span>{view.getSelectedIndex(nodeId) + 1} / {view.getSiblings(nodeId).length}</span>
    <button
      onClick={() => view.select(nodeId, view.getSelectedIndex(nodeId) + 1)}
      disabled={view.getSelectedIndex(nodeId) === view.getSiblings(nodeId).length - 1}
    >
      →
    </button>
  </div>
)}
```

Calling `select` updates the view's active branch and re-renders with the selected path.

## Server handling

The server receives `forkOf` and `parent` in the POST body. Pass them through to `newTurn`:

```typescript
const { turnId, clientId, forkOf, parent, messages, history } = await req.json();

const turn = transport.newTurn({ turnId, clientId, parent, forkOf });
await turn.start();

// Publish user messages to the channel so all clients see them and they persist in history
if (messages.length > 0) {
  await turn.addMessages(messages, { clientId });
}

const result = streamText({ model, messages: conversationHistory, abortSignal: turn.abortSignal });
const { reason } = await turn.streamResponse(result.toUIMessageStream());
await turn.end(reason);
```

The transport stamps `x-ably-parent` and `x-ably-fork-of` headers on the published messages. All clients on the channel see these headers and update their local tree.

## Multiple views

With a single view, navigating to a different branch in one part of the UI changes what every other part sees. Split-pane comparison UIs need independent views so each pane can show a different branch of the same conversation without interfering with the other.

`useCreateView` has the same API as `useView` but creates an independent view instead of using the transport's default. The view is closed automatically when the component unmounts or the transport changes:

```typescript
import { useClientTransport, useCreateView, useView } from '@ably/ai-transport/react';

const transport = useClientTransport({ channel, codec, clientId });

// Default view for the left pane
const left = useView(transport, { limit: 50 });

// Independent view for the right pane (only created when split is active)
const right = useCreateView(split ? transport : undefined, { limit: 50 });

// Selecting a sibling in the left pane does not affect the right pane
left.select(nodeId, 1);
```

Both views share the same underlying tree - new messages from the server appear in both. But branch selections, pagination windows, and write operations are scoped to each view.

See [React hooks reference](../reference/react-hooks.md#usecreateview) for the full `useCreateView` API.

## Tree from history

When a new client loads history (see [History](history.md)), the tree is reconstructed from the stored headers. All branches and their sibling relationships are preserved - the new client can navigate the same forks as a client that was present for the original conversation.

For the internal data structures and algorithms behind the tree, see [Conversation tree](../internals/conversation-tree.md). For the wire-level headers that drive branching, see [Wire protocol: branching headers](../internals/wire-protocol.md#branching-headers).
