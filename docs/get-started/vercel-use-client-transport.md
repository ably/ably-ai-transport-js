# Get Started: Vercel AI SDK with generic hooks

Build a streaming chat app using AI Transport's generic React hooks instead of Vercel's `useChat()`. This path gives you direct access to the transport's conversation tree, individual send/regenerate/edit operations, and full control over message state.

The server code is identical to the [useChat quickstart](vercel-use-chat.md) - only the client differs.

## Prerequisites

Same as the [useChat quickstart](vercel-use-chat.md#prerequisites). Follow steps 1-3 there to set up the token endpoint, Ably provider, and API route. The server code is the same.

## Create the chat component

Instead of `useChat()`, compose the generic hooks directly:

```typescript
// app/chat.tsx
'use client';

import { useChannel, ChannelProvider } from 'ably/react';
import {
  useClientTransport,
  useSend,
  useRegenerate,
  useActiveTurns,
  useHistory,
  useConversationTree,
} from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import type { UIMessage } from 'ai';
import { useState } from 'react';

// Resolve the x-ably-msg-id for a message. Tree methods and regenerate/edit
// use x-ably-msg-id as the key, not UIMessage.id.
function treeMsgId(msg: UIMessage, transport: ReturnType<typeof useClientTransport>): string {
  const headers = transport.getMessageHeaders(msg);
  return headers?.['x-ably-msg-id'] ?? msg.id;
}

function ChatInner({ chatId, clientId }: { chatId: string; clientId?: string }) {
  const { channel } = useChannel({ channelName: chatId });
  const [input, setInput] = useState('');

  // Create the transport - codec is passed explicitly since we're using generic hooks.
  // body merges extra fields into every HTTP POST - the server uses `id` to
  // identify which Ably channel to publish the response to.
  const transport = useClientTransport({
    channel,
    codec: UIMessageCodec,
    clientId,
    body: () => ({ id: chatId }),
  });

  // Each operation is a separate hook
  const tree = useConversationTree(transport);
  const send = useSend(transport);
  const regenerate = useRegenerate(transport);
  const activeTurns = useActiveTurns(transport);
  const history = useHistory(transport, { limit: 30 });

  const isStreaming = activeTurns.size > 0;

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');

    const userMsg: UIMessage = {
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
      {history.hasNext && (
        <button onClick={() => history.next()} disabled={history.loading}>
          Load older messages
        </button>
      )}

      {/* Message list from the conversation tree */}
      {tree.messages.map((msg) => {
        const nodeId = treeMsgId(msg, transport);
        return (
          <div key={msg.id}>
            <strong>{msg.role}:</strong>
            {msg.parts.map((part, i) => (
              part.type === 'text' ? <span key={i}>{part.text}</span> : null
            ))}

            {/* Branch navigation */}
            {tree.hasSiblings(nodeId) && (
              <span>
                {tree.getSelectedIndex(nodeId) + 1} / {tree.getSiblings(nodeId).length}
                <button onClick={() => tree.selectSibling(nodeId, tree.getSelectedIndex(nodeId) - 1)}>prev</button>
                <button onClick={() => tree.selectSibling(nodeId, tree.getSelectedIndex(nodeId) + 1)}>next</button>
              </span>
            )}

            {/* Regenerate assistant messages */}
            {msg.role === 'assistant' && (
              <button onClick={() => regenerate(nodeId)}>Regenerate</button>
            )}
          </div>
        );
      })}

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
    <ChannelProvider channelName={chatId}>
      <ChatInner chatId={chatId} clientId={clientId} />
    </ChannelProvider>
  );
}
```

## Key differences from the useChat path

| | useChat path | Generic hooks path |
|---|---|---|
| **Message state** | Managed by `useChat()` | Managed by `useConversationTree()` |
| **Send** | `sendMessage({ text })` | `send([uiMessage])` - you construct the `UIMessage` |
| **Regenerate** | `regenerate({ messageId })` | `regenerate(messageId)` |
| **Edit** | Not built into `useChat()` | `edit(messageId, [newMessage])` |
| **Branch navigation** | Not available | `tree.getSiblings()`, `tree.selectSibling()` |
| **Stop** | `stop()` from `useChat()` | `transport.cancel({ own: true })` |
| **Observer sync** | Requires `useMessageSync()` | Built-in - `tree.messages` includes all clients |
| **Hooks needed** | `useChatTransport()` + `useMessageSync()` | Individual hooks per operation |

Use the **`useChat()` path** when you want the simplest integration and Vercel's `useChat()` handles your needs. Use the **generic hooks path** when you need conversation branching UI, custom message construction, or tighter control over transport operations.

## Next steps

- [Conversation branching](../features/branching.md) - the generic hooks path gives you full fork navigation
- [Cancel](../features/cancel.md) - granular cancel with filter scopes
- [Interruption](../features/interruption.md) - send messages while the AI is streaming
- [React hooks reference](../reference/react-hooks.md) - complete API for all hooks
