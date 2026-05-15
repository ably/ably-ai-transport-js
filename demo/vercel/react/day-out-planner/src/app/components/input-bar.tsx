'use client';

import { useCallback, useState } from 'react';
import type { ActiveRun, SendOptions } from '@ably/ai-transport';
import type { UIMessage, UIMessageChunk } from 'ai';
import { userMessage } from '../helpers';

type SendFn = (messages: UIMessage[], options?: SendOptions) => Promise<ActiveRun<UIMessageChunk>>;

export function InputBar({ send }: { send: SendFn }) {
  const [input, setInput] = useState('');

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    void send([userMessage(text)]);
  }, [input, send]);

  return (
    <div className="border-t border-zinc-800 px-4 py-3">
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Type a message — mention @bernard to plan"
          className="flex-1 rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
          autoFocus
        />
        <button
          type="button"
          onClick={submit}
          disabled={!input.trim()}
          className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
