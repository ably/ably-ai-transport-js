'use client';

import { useChat } from '@ai-sdk/react';
import type * as AI from 'ai';
import { useClientTransport, useActiveTurns, useView, useAblyMessages } from '@ably/ai-transport/react';
import { useChatTransport, useMessageSync } from '@ably/ai-transport/vercel/react';
import { useState, useEffect, useCallback } from 'react';
import { MessageList } from './components/message-list';
import { DebugPane } from './components/debug-pane';
import type { CallbackLogEntry } from './components/debug-pane';
import { useClientTools } from './hooks/use-client-tools';

// ---------------------------------------------------------------------------
// Chat component
// ---------------------------------------------------------------------------

export function Chat({ chatId, clientId, historyLimit }: { chatId: string; clientId?: string; historyLimit?: number }) {
  // Transport is created by TransportProvider in page.tsx
  const transport = useClientTransport<AI.UIMessageChunk, AI.UIMessage>({ channelName: chatId });
  const chatTransport = useChatTransport(transport);

  // -- Callback & status logging for debug pane ----------------------------
  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
  }, []);

  const {
    setMessages,
    sendMessage,
    stop,
    status,
    regenerate,
    addToolResult,
    messages: chatMessages,
  } = useChat({
    id: chatId,
    transport: chatTransport,
    onToolCall: ({ toolCall }) => {
      setCallbackLog(prev => [...prev, {
        time: Date.now(),
        type: 'onToolCall',
        summary: `${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
      }]);
    },
    onFinish: ({ message, finishReason }) => {
      setCallbackLog(prev => [...prev, {
        time: Date.now(),
        type: 'onFinish',
        summary: `reason=${String(finishReason)}, parts=${String(message.parts.length)}`,
      }]);
    },
  });

  useMessageSync(transport, setMessages, chatTransport);

  // Track status transitions
  useEffect(() => {
    setStatusLog(prev => [...prev, { time: Date.now(), status }]);
  }, [status]);

  const activeTurns = useActiveTurns({ transport });
  const hasAnyTurns = activeTurns.size > 0;

  // Auto-loads first page on mount
  const { nodes, hasOlder, loading, loadOlder } = useView({ transport, limit: historyLimit ?? 30 });

  useClientTools(chatMessages, addToolResult, nodes, clientId);

  const ablyMessages = useAblyMessages({ transport });

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header clientId={clientId} />
        <MessageList
          nodes={nodes}
          hasOlder={hasOlder}
          loading={loading}
          onLoadOlder={loadOlder}
          onRegenerate={(messageId) => regenerate({ messageId })}
        />
        <InputBar
          onSend={(text) => sendMessage({ text })}
          onStop={stop}
          hasAnyTurns={hasAnyTurns}
        />
      </div>
      <DebugPane
        messages={nodes.map((n) => n.message)}
        ablyMessages={ablyMessages}
        activeTurns={activeTurns}
        status={status}
        callbackLog={callbackLog}
        statusLog={statusLog}
        onClearLogs={clearLogs}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ clientId }: { clientId?: string }) {
  return (
    <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
      <div className="h-2 w-2 rounded-full bg-emerald-500" />
      <h1 className="text-sm font-medium text-zinc-300">Ably AI — Vercel UI SDK</h1>
      {clientId && <span className="ml-auto text-xs text-zinc-600 font-mono">{clientId}</span>}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Input bar — single Stop button when streaming, Send button otherwise
// ---------------------------------------------------------------------------

function InputBar({
  onSend,
  onStop,
  hasAnyTurns,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  hasAnyTurns: boolean;
}) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    onSend(text);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-zinc-800 px-4 py-3 flex gap-2"
    >
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Type a message..."
        className="flex-1 rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
        autoFocus
      />
      {hasAnyTurns ? (
        <button
          type="button"
          onClick={onStop}
          className="rounded-md bg-red-900/60 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/80 transition-colors"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={!input.trim()}
          className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      )}
    </form>
  );
}
