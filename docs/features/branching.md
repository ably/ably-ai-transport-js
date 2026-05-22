# Conversation branching

AI Transport stores conversation history as a tree, not a linear array. When a user regenerates an assistant response or edits a user message, the session creates a fork - the original message and its replacement are siblings in the tree, and the user can navigate between them.

Without tree-based history, regeneration and editing destroy the original response. With branching, every version is preserved and navigable.

## How it works

Every message in the tree has:

- **`msgId`** - unique identifier (stamped as `x-ably-msg-id`)
- **`parentId`** - the preceding message in the thread (`x-ably-parent`)
- **`forkOf`** - the message this one replaces (`x-ably-fork-of`), if it's a fork

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
// nodeId is the x-ably-msg-id (see treeMsgId helper in the quickstart).
await regenerate(nodeId);
```

The session automatically computes `forkOf` (the assistant message being replaced) and `parent` (the message before it). The server receives these in the POST body and passes them to `createRun()`.

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
// nodeId is the x-ably-msg-id (see treeMsgId helper in the quickstart).
await edit(nodeId, [newMessage]);
```

## Branch navigation

`useView()` provides branch navigation alongside message state. The tree is keyed by **runId** (one Run per turn), so branch navigation operates at the Run level:

```typescript
import { useView } from '@ably/ai-transport/react';

const view = useView();

// view.hasSiblingRuns(runId) - does this Run have alternatives?
// view.getSiblingRuns(runId) - all alternative Runs at this fork point
// view.getSelectedIndex(runId) - which sibling Run is currently selected
// view.select(runId, index) - switch to a different sibling Run
// view.getRunNode(runId) - look up a Run by runId
// view.getRunByMsgId(msgId) - resolve the owning Run for a given message id
//
// Iterate view.nodes (RunNode[]):
//   view.nodes.map((run) => {
//     // run.runId - branch navigation key
//     // run.projection - codec-folded per-Run state
//   });
```

Build a sibling navigator at a Run fork point:

```typescript
{view.hasSiblingRuns(runId) && (
  <div>
    <button
      onClick={() => view.select(runId, view.getSelectedIndex(runId) - 1)}
      disabled={view.getSelectedIndex(runId) === 0}
    >
      ←
    </button>
    <span>{view.getSelectedIndex(runId) + 1} / {view.getSiblingRuns(runId).length}</span>
    <button
      onClick={() => view.select(runId, view.getSelectedIndex(runId) + 1)}
      disabled={view.getSelectedIndex(runId) === view.getSiblingRuns(runId).length - 1}
    >
      →
    </button>
  </div>
)}
```

If your UI holds a message id (e.g. from a previous render) rather than a runId, use `view.getRunByMsgId(msgId)?.runId` to resolve it.

Calling `select` updates the view's active branch and re-renders with the selected path.

## Server handling

The server receives `forkOf` and `parent` in the POST body. Pass them through to `createRun()`:

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

The session stamps `x-ably-parent` and `x-ably-fork-of` headers on the published messages. All clients on the channel see these headers and update their local tree.

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
