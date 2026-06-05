# Conversation branching

AI Transport stores conversation history as a tree, not a linear array. When a user regenerates an assistant response or edits a user message, the session creates a fork - the original message and its replacement are siblings in the tree, and the user can navigate between them.

Without tree-based history, regeneration and editing destroy the original response. With branching, every version is preserved and navigable.

## How it works

Every message in the tree has:

- **`msgId`** - unique identifier (stamped as `msg-id`)
- **`parentId`** - the preceding message in the thread (`parent`)
- **`forkOf`** - the message this one replaces (`fork-of`), if it's a fork

When you regenerate or edit, the session sets `forkOf` to the original message's ID. Messages that share the same `parentId` and fork the same original are **siblings** - alternatives at the same point in the conversation.

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

const { regenerate } = useView();

// Fork the assistant message - starts a new run with no new user messages.
// nodeId is the msg-id (see treeMsgId helper in the quickstart).
await regenerate(nodeId);
```

The session automatically computes `forkOf` (the assistant message being replaced) and `parent` (the message before it). These travel on the channel wire headers of the published input, not in the invocation pointer — the agent reads them off the triggering input event during its lookup.

## Edit

Editing forks a user message - the user provides replacement content, and the server produces a new response:

```typescript
import { useView } from '@ably/ai-transport/react';

const { edit } = useView();

const newMessage = {
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text: 'What is Go?' }],
  createdAt: new Date(),
};

// Fork the user message with new content.
// nodeId is the msg-id (see treeMsgId helper in the quickstart).
await edit(nodeId, [newMessage]);
```

## Branch navigation

`useView()` provides branch navigation alongside message state. Most UIs render a flat list of messages and want to attach navigation arrows to a specific message bubble (the edited user prompt, or the regenerated assistant reply), so the View exposes message-keyed branch navigation:

```typescript
import { useView } from '@ably/ai-transport/react';

const view = useView();

// view.hasMessageSiblings(msgId)           - does this message belong to a Run with siblings?
// view.getMessageSiblings(msgId)           - resolved sibling messages (TMessage[]); use .length for count
// view.getSelectedMessageSiblingIndex(msgId) - currently selected sibling index
// view.selectMessageSibling(msgId, index)  - switch to a different sibling Run
// view.getMessageMetadata(msgId)           - { msgId, runId, clientId, status } primitives for rendering
```

Build a sibling navigator anchored to a message:

```typescript
{view.hasMessageSiblings(msgId) && (
  <div>
    <button
      onClick={() => view.selectMessageSibling(msgId, view.getSelectedMessageSiblingIndex(msgId) - 1)}
      disabled={view.getSelectedMessageSiblingIndex(msgId) === 0}
    >
      ←
    </button>
    <span>{view.getSelectedMessageSiblingIndex(msgId) + 1} / {view.getMessageSiblings(msgId).length}</span>
    <button
      onClick={() => view.selectMessageSibling(msgId, view.getSelectedMessageSiblingIndex(msgId) + 1)}
      disabled={view.getSelectedMessageSiblingIndex(msgId) === view.getMessageSiblings(msgId).length - 1}
    >
      →
    </button>
  </div>
)}
```

For direct structural access (for example navigating an explicit node tree), `session.tree.getNodeByCodecMessageId(id)` resolves the owning node (an `InputNode` or a `RunNode` — narrow on `kind`), `session.tree.getSiblingNodes(key)` returns its sibling group (edit versions for an input node, regenerate runs for a reply run), and `session.tree.getRunNode(runId)` looks up a reply run by its agent-minted run id.

Calling `select` updates the view's active branch and re-renders with the selected path.

## Server handling

The agent reads `forkOf` and `parent` from the triggering input event's wire headers during its lookup — they are not carried in the invocation pointer. Read the user messages off the channel via the run, then run the LLM:

```typescript
import { Invocation } from '@ably/ai-transport';

const { runId, clientId, forkOf, parent, messages, history } = await req.json();

const run = session.createRun(Invocation.fromJSON({ runId, clientId, parent, forkOf }));
await run.start();

// Publish user messages to the channel so all clients see them and they persist in history
if (messages.length > 0) {
  await run.addMessages(messages, { clientId });
}

const result = streamText({ model, messages: conversationHistory, abortSignal: run.abortSignal });
const { reason } = await run.pipe(result.toUIMessageStream());
await run.end(reason);
```

The session stamps `parent` and `fork-of` headers on the published messages. All clients on the channel see these headers and update their local tree.

## Multiple views

With a single view, navigating to a different branch in one part of the UI changes what every other part sees. Split-pane comparison UIs need independent views so each pane can show a different branch of the same conversation without interfering with the other.

`useCreateView()` has the same API as `useView()` but creates an independent view instead of using the session's default. The view is closed automatically when the component unmounts or the session changes:

```typescript
import { useCreateView, useView } from '@ably/ai-transport/react';

// Default view for the left pane
const left = useView({ limit: 50 });

// Independent view for the right pane (only created when split is active)
const right = useCreateView({ skip: !split, limit: 50 });

// Selecting a sibling in the left pane does not affect the right pane
left.select(nodeId, 1);
```

Both views share the same underlying tree - new messages from the server appear in both. But branch selections, pagination windows, and write operations are scoped to each view.

See [React hooks reference](../reference/react-hooks.md#usecreateview) for the full `useCreateView()` API.

## Tree from history

When a new client loads history (see [History](history.md)), the tree is reconstructed from the stored headers. All branches and their sibling relationships are preserved - the new client can navigate the same forks as a client that was present for the original conversation.

For the internal data structures and algorithms behind the tree, see [Conversation tree](../internals/conversation-tree.md). For the wire-level headers that drive branching, see [Wire protocol: branching headers](../internals/wire-protocol.md#branching-headers).
