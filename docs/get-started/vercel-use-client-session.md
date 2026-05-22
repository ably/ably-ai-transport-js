# Get Started: Vercel AI SDK with generic hooks

Build a streaming chat app using AI Transport's generic React hooks instead of Vercel's `useChat()`. This path gives you direct access to the session's conversation tree, individual send/regenerate/edit operations, and full control over message state.

The server code is identical to the [useChat quickstart](vercel-use-chat.md) - only the client differs.

## Prerequisites

Same as the [useChat quickstart](vercel-use-chat.md#prerequisites). Follow steps 1-3 there to set up the token endpoint, Ably provider, and API route. The server code is the same.

## Create the chat component

Instead of `useChat()`, compose the generic hooks directly. `ClientSessionProvider` creates the session — it reads the Realtime client from the surrounding `<AblyProvider>` and binds the session to the supplied `channelName`.

```typescript
// app/chat.tsx
'use client';

import {
  ClientSessionProvider,
  useClientSession,
  useActiveRuns,
  useView,
} from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import type * as AI from 'ai';
import { useState } from 'react';

function ChatInner({ chatId, clientId }: { chatId: string; clientId?: string }) {
  const [input, setInput] = useState('');

  // Read the session created by ClientSessionProvider
  const { session } = useClientSession<AI.UIMessageChunk, AI.UIMessage>();

  // useView provides message state, navigation, and write operations
  const { nodes, hasOlder, loading, loadOlder, send, regenerate, hasSiblings, getSiblings, getSelectedIndex, select } = useView({ session, limit: 30 });
  const activeRuns = useActiveRuns({ session });
  const ownRunIds = clientId ? activeRuns.get(clientId) : undefined;

  const isStreaming = (ownRunIds?.size ?? 0) > 0;

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');

    const userMsg: AI.UIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: new Date(),
    };
    send([userMsg]);
  };

  return (
    <div>
      {/* History scroll-back */}
      {hasOlder && (
        <button onClick={() => loadOlder()} disabled={loading}>
          Load older messages
        </button>
      )}

      {/* Message list — render the flat TMessage[] from view.getMessages() */}
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}:</strong>
          {m.parts.map((part, i) => (
            part.type === 'text' ? <span key={i}>{part.text}</span> : null
          ))}

          {/* Branch navigation: resolve the message's owning Run for sibling controls */}
          {(() => {
            const owningRunId = getRunByMsgId(m.id)?.runId;
            if (!owningRunId || !hasSiblingRuns(owningRunId)) return null;
            const idx = getSelectedIndex(owningRunId);
            return (
              <span>
                {idx + 1} / {getSiblingRuns(owningRunId).length}
                <button onClick={() => select(owningRunId, idx - 1)}>prev</button>
                <button onClick={() => select(owningRunId, idx + 1)}>next</button>
              </span>
            );
          })()}

          {/* Regenerate assistant messages */}
          {m.role === 'assistant' && (
            <button onClick={() => regenerate(m.id)}>Regenerate</button>
          )}
        </div>
      ))}

      {/* Input */}
      <form onSubmit={(e) => { e.preventDefault(); handleSend(); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={() => {
              if (!ownRunIds) return;
              for (const runId of ownRunIds) void session.cancel(runId);
            }}
          >
            Stop
          </button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>
    </div>
  );
}

export function Chat({ chatId, clientId }: { chatId: string; clientId?: string }) {
  return (
    // ClientSessionProvider creates the ClientSession (reading the Realtime
    // client from the surrounding <AblyProvider>) and merges `body` into every
    // HTTP POST so the server knows which channel to use.
    <ClientSessionProvider
      channelName={chatId}
      codec={UIMessageCodec}
      clientId={clientId}
      api="/api/chat"
      body={() => ({ id: chatId })}
    >
      <ChatInner chatId={chatId} clientId={clientId} />
    </ClientSessionProvider>
  );
}
```

## Key differences from the useChat path

<<<<<<< HEAD
|                       | useChat path                              | Generic hooks path                                                          |
| --------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| **Message state**     | Managed by `useChat()`                    | Managed by `useView()`                                                      |
| **Send**              | `sendMessage({ text })`                   | `send([uiMessage])` - you construct the `UIMessage`                         |
| **Regenerate**        | `regenerate({ messageId })`               | `regenerate(messageId)`                                                     |
| **Edit**              | Not built into `useChat()`                | `edit(messageId, [newMessage])`                                             |
| **Branch navigation** | Not available                             | `view.getSiblings()`, `view.select()` via `useView()`                       |
| **Stop**              | `stop()` from `useChat()`                 | `session.cancel(runId)` per active run (iterate `activeRuns.get(clientId)`) |
| **Observer sync**     | Requires `useMessageSync()`               | Built-in - `useView()` includes all clients                                 |
| **Hooks needed**      | `useChatTransport()` + `useMessageSync()` | Individual hooks per operation                                              |
=======
|                       | useChat path                              | Generic hooks path                                       |
| --------------------- | ----------------------------------------- | -------------------------------------------------------- |
| **Message state**     | Managed by `useChat()`                    | Managed by `useView()`                                   |
| **Send**              | `sendMessage({ text })`                   | `send([uiMessage])` - you construct the `UIMessage`      |
| **Regenerate**        | `regenerate({ messageId })`               | `regenerate(messageId)`                                  |
| **Edit**              | Not built into `useChat()`                | `edit(messageId, [newMessage])`                          |
| **Branch navigation** | Not available                             | `view.getSiblingRuns()`, `view.select()` via `useView()` |
| **Stop**              | `stop()` from `useChat()`                 | `session.cancel({ own: true })`                          |
| **Observer sync**     | Requires `useMessageSync()`               | Built-in - `useView()` includes all clients              |
| **Hooks needed**      | `useChatTransport()` + `useMessageSync()` | Individual hooks per operation                           |
>>>>>>> 5d0ab5e (Tree of Runs: Convert the conversation tree from message-keyed to run-keyed)

Use the **useChat path** when you want the simplest integration and Vercel's `useChat()` handles your needs. Use the **generic hooks path** when you need conversation branching UI, custom message construction, or tighter control over session operations.

## Next steps

- [Conversation branching](../features/branching.md) - the generic hooks path gives you full fork navigation
- [Cancel](../features/cancel.md) - per-run cancel via `session.cancel(runId)`
- [Interruption](../features/interruption.md) - send messages while the AI is streaming
- [React hooks reference](../reference/react-hooks.md) - complete API for all hooks
