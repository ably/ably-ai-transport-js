'use client';

import { useChat } from '@ai-sdk/react';
import { useChannel, ChannelProvider } from 'ably/react';
import { useClientTransport, useView } from '@ably/ai-transport/react';
import { useChatTransport, useMessageSync } from '@ably/ai-transport/vercel/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { useState } from 'react';
import { MessageBubble } from './components/message-bubble';
import { useAblyReady } from './providers';

export function AblyChat({ chatId }: { chatId: string }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div style={{ color: '#71717a', padding: 40, textAlign: 'center' }}>Connecting to Ably...</div>;
  }

  return (
    <ChannelProvider channelName={chatId}>
      <AblyChatInner chatId={chatId} />
    </ChannelProvider>
  );
}

function AblyChatInner({ chatId }: { chatId: string }) {
  const { channel } = useChannel({ channelName: chatId });
  const transport = useClientTransport({
    channel,
    codec: UIMessageCodec,
    api: '/api/chat/ably',
    body: () => ({ id: chatId }),
  });
  const chatTransport = useChatTransport(transport);

  const { setMessages, sendMessage, regenerate, status } = useChat({
    id: chatId,
    transport: chatTransport,
  });

  useMessageSync(transport, setMessages);

  const view = useView(transport, { limit: 50 });
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ fontSize: 11, color: '#71717a', padding: '4px 0' }}>
        Mode: <strong>AI Transport</strong> (Ably) &mdash; {view.nodes.length} nodes
        {view.hasOlder ? ' (more available)' : ''}
      </div>

      {/* Load older */}
      {view.hasOlder && (
        <button
          onClick={view.loadOlder}
          disabled={view.loading}
          style={{
            fontSize: 11,
            color: '#71717a',
            background: 'none',
            border: '1px solid #333',
            borderRadius: 4,
            padding: '4px 8px',
            cursor: 'pointer',
            alignSelf: 'center',
            margin: '4px 0',
          }}
        >
          {view.loading ? 'Loading...' : 'Load older'}
        </button>
      )}

      {/* Messages from the tree view */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
        {view.nodes.map((node) => (
          <MessageBubble
            key={node.message.id}
            message={node.message}
            branchNav={{
              hasSiblings: view.hasSiblings(node.msgId),
              total: view.getSiblings(node.msgId).length,
              selectedIndex: view.getSelectedIndex(node.msgId),
              onSelect: (index) => view.select(node.msgId, index),
            }}
            onEditViaUseChat={
              node.message.role === 'user' ? (text) => sendMessage({ text, messageId: node.message.id }) : undefined
            }
            onEditViaTransport={
              node.message.role === 'user'
                ? (text) =>
                    view.edit(node.msgId, [{ role: 'user', id: node.message.id, parts: [{ type: 'text', text }] }])
                : undefined
            }
            onRegenerateViaUseChat={
              node.message.role === 'assistant' ? () => regenerate({ messageId: node.message.id }) : undefined
            }
            onRegenerateViaTransport={node.message.role === 'assistant' ? () => view.regenerate(node.msgId) : undefined}
          />
        ))}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', gap: 8, borderTop: '1px solid #333', paddingTop: 12 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a message..."
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid #3f3f46',
            background: '#18181b',
            color: '#e4e4e7',
            outline: 'none',
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={!input.trim()}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            background: '#3f3f46',
            color: '#e4e4e7',
            cursor: 'pointer',
            fontSize: 14,
            opacity: !input.trim() ? 0.4 : 1,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
