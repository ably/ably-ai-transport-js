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
import { useRegenerate } from '@ably/ai-transport/react';

const regenerate = useRegenerate(transport);

// Fork the assistant message - starts a new turn with no new user messages.
// nodeId is the x-ably-msg-id (see treeMsgId helper in the quickstart).
await regenerate(nodeId);
```

The transport automatically computes `forkOf` (the assistant message being replaced) and `parent` (the message before it). The server receives these in the POST body and passes them to `newTurn`.

## Edit

Editing forks a user message - the user provides replacement content, and the server produces a new response:

```typescript
import { useEdit } from '@ably/ai-transport/react';

const edit = useEdit(transport);

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

`useConversationTree` provides the tree state and navigation:

```typescript
import { useConversationTree } from '@ably/ai-transport/react';

const tree = useConversationTree(transport);

// tree.messages - linear message list for the current branch
// tree.hasSiblings(nodeId) - does this message have alternatives?
// tree.getSiblings(nodeId) - all alternatives at this fork point
// tree.getSelectedIndex(nodeId) - which sibling is currently selected
// tree.selectSibling(nodeId, index) - switch to a different sibling
//
// nodeId is the x-ably-msg-id for each message - iterate getMessagesWithHeaders()
// to get messages paired with their headers:
//   transport.getMessagesWithHeaders().map(({ message: msg, headers }) => {
//     const nodeId = headers?.['x-ably-msg-id'] ?? msg.id;
//   });
```

Build a sibling navigator (where `nodeId` is the resolved `x-ably-msg-id` for the message):

```typescript
{tree.hasSiblings(nodeId) && (
  <div>
    <button
      onClick={() => tree.selectSibling(nodeId, tree.getSelectedIndex(nodeId) - 1)}
      disabled={tree.getSelectedIndex(nodeId) === 0}
    >
      ←
    </button>
    <span>{tree.getSelectedIndex(nodeId) + 1} / {tree.getSiblings(nodeId).length}</span>
    <button
      onClick={() => tree.selectSibling(nodeId, tree.getSelectedIndex(nodeId) + 1)}
      disabled={tree.getSelectedIndex(nodeId) === tree.getSiblings(nodeId).length - 1}
    >
      →
    </button>
  </div>
)}
```

Calling `selectSibling` updates the tree's active branch. `tree.messages` re-renders with the selected path.

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

## Tree from history

When a new client loads history (see [History](history.md)), the tree is reconstructed from the stored headers. All branches and their sibling relationships are preserved - the new client can navigate the same forks as a client that was present for the original conversation.

For the internal data structures and algorithms behind the tree, see [Conversation tree](../internals/conversation-tree.md). For the wire-level headers that drive branching, see [Wire protocol: branching headers](../internals/wire-protocol.md#branching-headers).
