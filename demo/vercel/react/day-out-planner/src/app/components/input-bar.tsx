'use client';

import { useCallback, useRef, useState } from 'react';
import type { ActiveRun, SendOptions } from '@ably/ai-transport';
import type { UIMessage, UIMessageChunk } from 'ai';
import { userMessage } from '../helpers';

type SendFn = (messages: UIMessage[], options?: SendOptions) => Promise<ActiveRun<UIMessageChunk>>;

const MENTION_TARGET = 'bernard';

/**
 * If the text immediately before the cursor looks like a partial @mention that
 * is a prefix of `MENTION_TARGET` (and not already complete), return the
 * range that should be replaced on Tab. Otherwise null.
 */
function detectMentionPartial(input: string, cursor: number): { start: number; end: number } | null {
  const before = input.slice(0, cursor);
  const match = before.match(/@([a-z0-9]*)$/i);
  if (!match) return null;
  const partial = match[1].toLowerCase();
  if (partial === MENTION_TARGET) return null;
  if (!MENTION_TARGET.startsWith(partial)) return null;
  return { start: cursor - partial.length - 1, end: cursor };
}

export function InputBar({ send }: { send: SendFn }) {
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const mention = detectMentionPartial(input, cursor);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setCursor(0);
    void send([userMessage(text)]);
  }, [input, send]);

  const completeMention = useCallback(() => {
    if (!mention) return;
    const before = input.slice(0, mention.start);
    const after = input.slice(mention.end);
    const replacement = `@${MENTION_TARGET} `;
    const next = before + replacement + after;
    const nextCursor = before.length + replacement.length;
    setInput(next);
    setCursor(nextCursor);
    // The cursor position has to be set on the DOM node after React has
    // applied the new value.
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }, [input, mention]);

  return (
    <div className="border-t border-zinc-800 px-4 py-3">
      <div className="relative flex gap-2">
        {mention && (
          <div className="pointer-events-none absolute -top-7 left-0 rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 shadow">
            <span className="text-zinc-500">Tab to complete: </span>
            <span className="font-mono">@{MENTION_TARGET}</span>
          </div>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setCursor(e.target.selectionEnd ?? e.target.value.length);
          }}
          onSelect={(e) => setCursor(e.currentTarget.selectionEnd ?? 0)}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && mention) {
              e.preventDefault();
              completeMention();
              return;
            }
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
