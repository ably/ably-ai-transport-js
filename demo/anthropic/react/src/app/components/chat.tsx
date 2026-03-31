'use client';

import { useState, useCallback } from 'react';
import { useChannel } from 'ably/react';
import {
  useClientTransport,
  useSend,
  useActiveTurns,
  useHistory,
  useConversationTree,
  useAblyMessages,
} from '@ably/ai-transport/react';
import { AgentCodec } from '@ably/ai-transport/anthropic';
import type { AgentCodecEvent, AgentMessage } from '@ably/ai-transport/anthropic';

import { userMessage } from '../helpers';
import { MessageList } from './message-list';
import { DebugPane } from './debug-pane';

interface ChatProps {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
}

export function Chat({ chatId, clientId, historyLimit }: ChatProps) {
  const { channel } = useChannel({ channelName: chatId });
  const [input, setInput] = useState('');

  const transport = useClientTransport<AgentCodecEvent, AgentMessage>({
    channel,
    codec: AgentCodec,
    clientId,
    body: () => ({ id: chatId }),
  });

  const tree = useConversationTree(transport);
  const send = useSend(transport);
  const activeTurns = useActiveTurns(transport);
  const history = useHistory(transport, { limit: historyLimit ?? 30 });
  const ablyMessages = useAblyMessages(transport);

  const hasOwnTurns = clientId ? activeTurns.has(clientId) : false;

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    send([userMessage(text)]);
  }, [input, send]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <h1 className="text-sm font-medium text-zinc-300">Ably AI — Anthropic Agent SDK Demo</h1>
          {clientId && <span className="ml-auto text-xs text-zinc-600 font-mono">{clientId}</span>}
        </header>

        {/* Messages */}
        <MessageList
          tree={tree}
          hasNext={history.hasNext}
          loading={history.loading}
          onNext={() => history.next()}
        />

        {/* Input */}
        <div className="border-t border-zinc-800 px-4 py-3">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              className="flex-1 rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
              autoFocus
            />
            {hasOwnTurns && (
              <button
                type="button"
                onClick={() => transport.cancel({ own: true })}
                className="rounded-md bg-red-900/60 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/80 transition-colors"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!input.trim()}
              className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      <DebugPane
        messages={tree.messages}
        ablyMessages={ablyMessages}
        activeTurns={activeTurns}
      />
    </div>
  );
}
