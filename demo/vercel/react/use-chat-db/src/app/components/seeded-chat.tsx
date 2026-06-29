'use client';

import { useChat } from '@ai-sdk/react';
import { useChatTransport, useMessageSync } from '@ably/ai-transport/vercel/react';
import type { UIMessage } from 'ai';
import { useEffect, useState } from 'react';

// Concatenate a message's text parts for a plain linear render.
function messageText(message: UIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** Props for {@link SeededChat}. */
export interface SeededChatProps {
  /** The conversation id (the channel name); also `useChat`'s `id`. */
  chatId: string;
  /** The persisted conversation loaded from the database, used to seed `useChat`. */
  seed: UIMessage[];
}

/**
 * A deliberately minimal, linear chat that seeds `useChat` from the database and
 * reconciles it with the live channel via `useMessageSync`: the agent has
 * persisted each completed turn to the store, and on load the stored
 * conversation renders immediately while the live channel is stitched on at the
 * seam with no duplicate.
 *
 * It renders straight from `useChat`'s `messages` (no branch navigation), so the
 * seam-walk in `useMessageSync` is the sole driver of channel history — the
 * precondition the single-overlap seam compose relies on. For the full branching
 * UI (and tools) see the sibling `use-chat` demo.
 * @param props - The conversation id and the database seed.
 */
export function SeededChat({ chatId, seed }: SeededChatProps): React.ReactElement {
  const { chatTransport, session } = useChatTransport();

  const { messages, setMessages, sendMessage, status, stop } = useChat({
    id: chatId,
    transport: chatTransport,
    messages: seed,
  });

  // useChat's status reflects the in-flight request: 'submitted'/'streaming'
  // while a response is arriving, 'error' on failure, 'ready' when idle. The
  // live state applies to the last assistant message; earlier ones are done.
  const streaming = status === 'submitted' || status === 'streaming';
  const responseState = (message: UIMessage, index: number): string | undefined => {
    if (message.role !== 'assistant') return undefined;
    if (index === messages.length - 1) {
      if (streaming) return 'streaming';
      if (status === 'error') return 'error';
    }
    return 'completed';
  };

  // Reconcile the database seed with the live channel: take the newest seed id
  // as the seam, page the channel back to it, and compose seed ⧺ live tail.
  // Pass the stable `seed` prop (not useChat's live `messages`): useMessageSync
  // writes the reconciled result back via setMessages, so feeding `messages`
  // back in as the seed would churn its reference every push and loop. The seed
  // is the fixed page-load history; new turns arrive through the live channel.
  useMessageSync({ messages: seed, setMessages });

  // Connect (subscribe + attach) before offering the composer — `connect()`
  // attaches the channel, so the first send always lands on an attached channel
  // rather than rejecting with "channel is initialized".
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const connect = async (): Promise<void> => {
      try {
        await session.connect();
        if (!cancelled) setConnected(true);
      } catch {
        // Connect/attach errors surface via session.on('error'); leave the
        // composer hidden.
      }
    };
    void connect();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const [input, setInput] = useState('');

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    // Linear history: a new turn cancels any still-streaming response first, so
    // the seam reconciliation only ever meets complete (or cancelled) turns.
    void (async () => {
      if (streaming) await stop();
      await sendMessage({ text });
    })();
  };

  return (
    <div className="mx-auto flex h-dvh max-w-2xl flex-col p-4">
      <h1 className="mb-3 text-sm font-medium text-zinc-300">Database hydration — DB seed ⧺ live channel</h1>
      <ul
        data-testid="messages"
        className="flex flex-1 flex-col gap-2 overflow-y-auto"
      >
        {messages.map((message, index) => {
          const state = responseState(message, index);
          return (
            <li
              key={message.id}
              data-testid="message"
              data-role={message.role}
              data-id={message.id}
              data-state={state}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            >
              <span className="mr-2 font-mono text-xs text-zinc-500">{message.role}</span>
              {messageText(message)}
              {state && (
                <span
                  data-testid="message-state"
                  className="ml-2 font-mono text-[10px] uppercase tracking-wide text-zinc-500"
                >
                  {state}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {connected ? (
        <form
          onSubmit={handleSubmit}
          className="mt-3 flex gap-2"
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type a message..."
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500"
          />
          {streaming ? (
            <button
              type="button"
              data-testid="stop"
              onClick={() => void stop()}
              className="rounded-md bg-red-900/60 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/80"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-40"
            >
              Send
            </button>
          )}
        </form>
      ) : (
        <div className="mt-3 text-sm text-zinc-600">Connecting channel…</div>
      )}
    </div>
  );
}
