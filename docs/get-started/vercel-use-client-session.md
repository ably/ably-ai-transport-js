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
  useView,
} from '@ably/ai-transport/react';
import type { ActiveRun } from '@ably/ai-transport';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import type * as AI from 'ai';
import { useState } from 'react';

// Wake the agent: the core session never sends HTTP, so the app POSTs the
// run's invocation pointer to its endpoint. The agent reads the conversation
// from the channel; the pointer carries only identifiers.
const wakeAgent = (run: ActiveRun<AI.UIMessageChunk>) =>
  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run.toInvocation().toJSON()),
  });

function ChatInner({ chatId, clientId }: { chatId: string; clientId?: string }) {
  const [input, setInput] = useState('');

  // Read the session created by ClientSessionProvider
  const { session } = useClientSession<AI.UIMessageChunk, AI.UIMessage>();

  // useView provides message state, navigation, and write operations
  const {
    messages,
    nodes,
    hasOlder,
    loading,
    loadOlder,
    send,
    regenerate,
    hasMessageSiblings,
    getMessageSiblings,
    getSelectedMessageSiblingIndex,
    selectMessageSibling,
  } = useView({ session, limit: 30 });

  // Read streaming state and the runId-to-cancel off the latest visible Run.
  // Terminal statuses ('complete' / 'cancelled') hide the Stop button.
  const latest = nodes.at(-1);
  const latestRunId = latest?.runId;
  const latestStatus = latest?.status;
  const isStreaming = latestRunId !== undefined && latestStatus !== 'complete' && latestStatus !== 'cancelled';

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');

    const userMsg: AI.UIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: new Date(),
    };
    // send() publishes the input on the channel and returns the run; then
    // POST the invocation to wake the agent.
    const run = await send([userMsg]);
    await wakeAgent(run);
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

          {/* Branch navigation: message-keyed sibling controls */}
          {hasMessageSiblings(m.id) && (() => {
            const idx = getSelectedMessageSiblingIndex(m.id);
            const count = getMessageSiblings(m.id).length;
            return (
              <span>
                {idx + 1} / {count}
                <button onClick={() => selectMessageSibling(m.id, idx - 1)}>prev</button>
                <button onClick={() => selectMessageSibling(m.id, idx + 1)}>next</button>
              </span>
            );
          })()}

          {/* Regenerate assistant messages */}
          {m.role === 'assistant' && (
            <button onClick={async () => wakeAgent(await regenerate(m.id))}>Regenerate</button>
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
              if (!latestRunId) return;
              void session.cancel(latestRunId);
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
    // client from the surrounding <AblyProvider>). The session is a pure
    // channel transport — it never sends HTTP — so the component above POSTs
    // the invocation to wake the agent.
    <ClientSessionProvider
      channelName={chatId}
      codec={UIMessageCodec}
      clientId={clientId}
    >
      <ChatInner chatId={chatId} clientId={clientId} />
    </ClientSessionProvider>
  );
}
```

## Key differences from the useChat path

|                       | useChat path                              | Generic hooks path                                                         |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| **Message state**     | Managed by `useChat()`                    | Managed by `useView()`                                                     |
| **Send**              | `sendMessage({ text })`                   | `send([uiMessage])` - you construct the `UIMessage`                        |
| **Regenerate**        | `regenerate({ messageId })`               | `regenerate(messageId)`                                                    |
| **Edit**              | Not built into `useChat()`                | `edit(messageId, [newMessage])`                                            |
| **Branch navigation** | Not available                             | `view.hasMessageSiblings()`, `view.selectMessageSibling()` via `useView()` |
| **Stop**              | `stop()` from `useChat()`                 | `session.cancel(runId)` — read the runId off the latest visible node       |
| **Observer sync**     | Requires `useMessageSync()`               | Built-in - `useView()` includes all clients                                |
| **Hooks needed**      | `useChatTransport()` + `useMessageSync()` | Individual hooks per operation                                             |

Use the **useChat path** when you want the simplest integration and Vercel's `useChat()` handles your needs. Use the **generic hooks path** when you need conversation branching UI, custom message construction, or tighter control over session operations.

## Next steps

- [Conversation branching](../features/branching.md) - the generic hooks path gives you full fork navigation
- [Cancel](../features/cancel.md) - per-run cancel via `session.cancel(runId)`
- [Interruption](../features/interruption.md) - send messages while the AI is streaming
- [React hooks reference](../reference/react-hooks.md) - complete API for all hooks
