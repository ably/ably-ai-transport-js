'use client';

import { useState, useCallback } from 'react';
import type { ClientTransport, ActiveTurn, SendOptions } from '@ably/ai-transport';
import type { UIMessageChunk, UIMessage } from 'ai';
import type { QueueHandle } from '../hooks/use-message-queue';
import { userMessage } from '../helpers';

type SendFn = (messages: UIMessage[], options?: SendOptions) => Promise<ActiveTurn<UIMessageChunk>>;

interface InputBarProps {
  transport: ClientTransport<UIMessageChunk, UIMessage>;
  send: SendFn;
  activeTurns: Map<string, Set<string>>;
  clientId: string | undefined;
  queue: QueueHandle;
}

export function InputBar({ transport, send, activeTurns, clientId, queue }: InputBarProps) {
  const [input, setInput] = useState('');

  const hasOwnTurns = clientId ? activeTurns.has(clientId) : false;
  const hasAnyTurns = activeTurns.size > 0;

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');

    if (hasOwnTurns) {
      queue.add(text);
    } else {
      send([userMessage(text)]);
    }
  }, [input, hasOwnTurns, send, queue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim()) handleSubmit();
    }
  };

  return (
    <div className="border-t border-zinc-800 px-4 py-3">
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={hasOwnTurns ? 'Type to queue a follow-up...' : 'Ask about an order, find products, or request a return...'}
          className="flex-1 rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
          autoFocus
        />
        {hasOwnTurns && (
          <button
            type="button"
            onClick={() => transport.cancel()}
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
          {hasOwnTurns ? 'Queue' : 'Send'}
        </button>
      </div>
    </div>
  );
}
