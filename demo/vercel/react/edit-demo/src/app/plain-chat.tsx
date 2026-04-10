'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import { MessageBubble } from './components/message-bubble';

export function PlainChat() {
  const { messages, sendMessage, regenerate, status } = useChat();
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
        Mode: <strong>Plain Vercel</strong> (default HTTP transport) &mdash; status: <strong>{status}</strong>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onEditViaUseChat={msg.role === 'user' ? (text) => sendMessage({ text, messageId: msg.id }) : undefined}
            onRegenerateViaUseChat={msg.role === 'assistant' ? () => regenerate({ messageId: msg.id }) : undefined}
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
          disabled={status === 'streaming'}
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
          disabled={status === 'streaming' || !input.trim()}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            background: '#3f3f46',
            color: '#e4e4e7',
            cursor: 'pointer',
            fontSize: 14,
            opacity: status === 'streaming' || !input.trim() ? 0.4 : 1,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
