# Get Started: Vercel AI SDK with generic hooks

Build a streaming chat app using AI Transport's generic React hooks instead of Vercel's `useChat()`. This path gives you direct access to the transport's conversation tree, individual send/regenerate/edit operations, and full control over message state.

The server code is identical to the [useChat quickstart](vercel-use-chat.md) - only the client differs.

## Prerequisites

Same as the [useChat quickstart](vercel-use-chat.md#prerequisites). Follow steps 1-3 there to set up the token endpoint, Ably provider, and API route. The server code is the same.

## Create the chat component

Instead of `useChat()`, compose the generic hooks directly. `TransportProvider` creates the transport and wraps children with Ably's `ChannelProvider` internally:

```typescript
// app/chat.tsx
'use client';

import {
  TransportProvider,
  useClientTransport,
  useActiveTurns,
  useView,
} from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import type * as AI from 'ai';
import { useState } from 'react';

function ChatInner({ chatId }: { chatId: string }) {
  const [input, setInput] = useState('');

  // Read the transport created by TransportProvider
  const { transport } = useClientTransport<AI.UIMessageChunk, AI.UIMessage>();

  // useView provides message state, navigation, and write operations
  const { nodes, hasOlder, loading, loadOlder, send, regenerate, hasSiblings, getSiblings, getSelectedIndex, select } = useView(transport, { limit: 30 });
  const activeTurns = useActiveTurns(transport);

  const isStreaming = activeTurns.size > 0;

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

      {/* Message list — each node has a typed msgId for tree navigation */}
      {nodes.map((node) => (
        <div key={node.message.id}>
          <strong>{node.message.role}:</strong>
          {node.message.parts.map((part, i) => (
            part.type === 'text' ? <span key={i}>{part.text}</span> : null
          ))}

          {/* Branch navigation */}
          {hasSiblings(node.msgId) && (
            <span>
              {getSelectedIndex(node.msgId) + 1} / {getSiblings(node.msgId).length}
              <button onClick={() => select(node.msgId, getSelectedIndex(node.msgId) - 1)}>prev</button>
              <button onClick={() => select(node.msgId, getSelectedIndex(node.msgId) + 1)}>next</button>
            </span>
          )}

          {/* Regenerate assistant messages */}
          {node.message.role === 'assistant' && (
            <button onClick={() => regenerate(node.msgId)}>Regenerate</button>
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
          <button type="button" onClick={() => transport.cancel({ own: true })}>Stop</button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>
    </div>
  );
}

export function Chat({ chatId, clientId }: { chatId: string; clientId?: string }) {
  return (
    // TransportProvider creates the ClientTransport, wraps children with ChannelProvider,
    // and merges `body` into every HTTP POST so the server knows which channel to use.
    <TransportProvider
      channelName={chatId}
      codec={UIMessageCodec}
      clientId={clientId}
      body={() => ({ id: chatId })}
    >
      <ChatInner chatId={chatId} />
    </TransportProvider>
  );
}
```

## Key differences from the useChat path

|                       | useChat path                              | Generic hooks path                                    |
| --------------------- | ----------------------------------------- | ----------------------------------------------------- |
| **Message state**     | Managed by `useChat()`                    | Managed by `useView()`                                |
| **Send**              | `sendMessage({ text })`                   | `send([uiMessage])` - you construct the `UIMessage`   |
| **Regenerate**        | `regenerate({ messageId })`               | `regenerate(messageId)`                               |
| **Edit**              | Not built into `useChat()`                | `edit(messageId, [newMessage])`                       |
| **Branch navigation** | Not available                             | `view.getSiblings()`, `view.select()` via `useView()` |
| **Stop**              | `stop()` from `useChat()`                 | `transport.cancel({ own: true })`                     |
| **Observer sync**     | Requires `useMessageSync()`               | Built-in - `useView()` includes all clients           |
| **Hooks needed**      | `useChatTransport()` + `useMessageSync()` | Individual hooks per operation                        |

Use the **useChat path** when you want the simplest integration and Vercel's `useChat()` handles your needs. Use the **generic hooks path** when you need conversation branching UI, custom message construction, or tighter control over transport operations.

## Next steps

- [Conversation branching](../features/branching.md) - the generic hooks path gives you full fork navigation
- [Cancel](../features/cancel.md) - granular cancel with filter scopes
- [Interruption](../features/interruption.md) - send messages while the AI is streaming
- [React hooks reference](../reference/react-hooks.md) - complete API for all hooks
