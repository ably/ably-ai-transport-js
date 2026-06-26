# Conversation branching

AI Transport stores conversation history as a tree, not a linear array. When a user regenerates an assistant response or edits a user message, the View creates a sibling branch - the original and its alternative coexist in the tree, and the user can navigate between them.

Without tree-based history, regeneration and editing destroy the original response. With branching, every version is preserved and navigable.

## How it works

Each conversation turn is two nodes: a user `InputNode` keyed by the client-owned codec-message-id, and an agent `RunNode` keyed by the agent-minted run-id and parented to the input node. Both kinds carry the same structural fields:

- **`codecMessageId`** / **`runId`** - the node's primary key (`codec-message-id` for inputs, the agent's run-id for runs)
- **`parentCodecMessageId`** - the codec-message-id of the preceding node on the chain (`parent`)
- **`forkOf`** - the codec-message-id this node replaces (`fork-of`), if it's a fork

Editing a prompt forks the **input node**: the replacement input node shares its `forkOf` anchor with the original, and same-anchor input nodes form the edit sibling group. Regenerating a reply does not use `forkOf` at all - the new reply run parents at the **same input node** as the original reply, so same-parent reply runs form the regenerate group. The session stamps the regenerate target on the `msg-regenerate` header of the published input event (the agent only reads it); the View realises the replacement when it materialises messages.

```
User: "What is Rust?"                       (input-1, parent: null)
  ├── Run: "Rust is a language..."           (run-1, parent: input-1)
  └── Run: "Rust is a systems..."            (run-2, parent: input-1)  ← regenerated (same input parent)
```

The live View's `getMessages()` returns the messages of the Tree's `visibleNodes()`, which walks the nodes applying parent reachability and **explicit sibling-group selection**: where a node has siblings, a selection map picks the active member (the user's selection, or the latest by default) and the others are skipped. The View then layers its pagination window on top and concatenates each visible node's projected messages into the flat list. (The agent's `loadConversation` and history decode use a different path — `buildBranchChain` — where branch selection is implicit-by-unreachability rather than an explicit selection map.) The user navigates between siblings to switch branches.

## Regenerate

Regeneration forks an assistant message - the server produces a new response for the same prompt:

```typescript
import { useView } from '@ably/ai-transport/react';

const { regenerate } = useView();

// Regenerate the assistant message - starts a new reply run with no new
// user messages. messageId is the assistant message's codec-message-id.
await regenerate(messageId);
```

The View resolves `target` (the assistant message being regenerated) and `parent` (the user prompt before it) from its branch, then mints a `Regenerate` input via the codec (`createRegenerate(target, parent)`). The session reads those fields off the input and writes `target` onto the `msg-regenerate` wire header and `parent` onto the `parent` header of the published input; the agent reads them off the triggering input event during its conversation lookup. A regenerate is a continuation, not a fork — the new reply run shares the original reply's input-node parent rather than carrying a `fork-of`.

## Edit

Editing forks a user message - the user provides replacement content, and the server produces a new response:

```typescript
import { useView } from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

const { edit } = useView();

const newMessage = {
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text: 'What is Go?' }],
  createdAt: new Date(),
};

// Fork the user message with new content. edit() takes codec inputs, so
// compose the replacement user message into one.
// messageId is the user message's codec-message-id.
await edit(messageId, UIMessageCodec.createUserMessage(newMessage));
```

## Branch navigation

`useView()` provides branch navigation alongside message state. Most UIs render a flat list of messages and want to attach navigation arrows to a specific message bubble (the edited user prompt, or the regenerated assistant reply), so the View exposes message-anchored branch navigation keyed by codec-message-id:

```typescript
import { useView } from '@ably/ai-transport/react';

const view = useView();

// view.branchSelection(codecMessageId) returns a total BranchHandle:
//   { hasSiblings, siblings, index, selected, select }
// - hasSiblings - is this codec-message-id a branch anchor with > 1 sibling?
// - siblings    - the alternatives (TMessage[]); use .length for the count
// - index       - the currently selected sibling's index
// - selected    - siblings[index] (the rendered message itself for plain bubbles)
// - select(index) - switch to a different sibling (index is clamped; silent
//                   no-op when the id is not a branch anchor)
//
// view.runOf(codecMessageId) returns the owning Run's RunInfo
//   ({ runId, clientId, status, invocationId }) for rendering.
```

The handle is total — `branchSelection` is safe to call for any rendered message. A non-anchor bubble returns `siblings = [message]` (length 1), so the render condition keys on `hasSiblings`. Build a sibling navigator anchored to a message:

```typescript
const branch = view.branchSelection(codecMessageId);

{branch.hasSiblings && (
  <div>
    <button
      onClick={() => branch.select(branch.index - 1)}
      disabled={branch.index === 0}
    >
      ←
    </button>
    <span>{branch.index + 1} / {branch.siblings.length}</span>
    <button
      onClick={() => branch.select(branch.index + 1)}
      disabled={branch.index === branch.siblings.length - 1}
    >
      →
    </button>
  </div>
)}
```

In the Vercel codec the domain `message.id` is the codec-message-id, so you pass `message.id` straight through.

For direct structural access (for example navigating an explicit node tree), `session.tree.getNodeByCodecMessageId(id)` resolves the owning node (an `InputNode` or a `RunNode` — narrow on `kind`), `session.tree.getSiblingNodes(key)` returns its sibling group (edit versions for an input node, regenerate runs for a reply run), and `session.tree.getRunNode(runId)` looks up a reply run by its agent-minted run id.

Calling `branch.select()` updates the view's active branch and re-renders with the selected path.

## Server handling

The agent receives only an invocation pointer — `{ inputEventId, sessionName }` — in the POST body, not the messages or branching metadata. It replays the triggering input event off the channel via rewind, then `loadConversation()` walks the branch chain from that input event (following `parent` links and resolving `fork-of` / `msg-regenerate`) to assemble the LLM-ready history. The agent never needs to read `forkOf` or `parent` itself:

```typescript
import { Invocation } from '@ably/ai-transport';
import type { InvocationData } from '@ably/ai-transport';

const data = (await req.json()) as InvocationData; // { inputEventId, sessionName }
const invocation = Invocation.fromJSON(data);

const run = session.createRun(invocation, { signal: req.signal });
await run.start();

// Walk the branch chain off the channel into LLM-ready history.
await run.loadConversation();

const result = streamText({ model, messages: run.messages, abortSignal: run.abortSignal });
const { reason } = await run.pipe(result.toUIMessageStream());
await run.end({ reason });
```

The client stamps `parent`, `fork-of`, and `msg-regenerate` headers on the published input event. All clients on the channel see these headers and update their local tree; the agent resolves them through `loadConversation`.

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
left.branchSelection(codecMessageId).select(1);
```

Both views share the same underlying tree - new messages from the server appear in both. But branch selections, pagination windows, and write operations are scoped to each view.

See [React hooks reference](../reference/react-hooks.md#usecreateview) for the full `useCreateView()` API.

## Tree from history

When a new client loads history (see [History](history.md)), the tree is reconstructed from the stored headers. All branches and their sibling relationships are preserved - the new client can navigate the same forks as a client that was present for the original conversation.

For the internal data structures and algorithms behind the tree, see [Conversation tree](../internals/conversation-tree.md). For the wire-level headers that drive branching, see [Wire protocol: branching headers](../internals/wire-protocol.md#branching-headers).
