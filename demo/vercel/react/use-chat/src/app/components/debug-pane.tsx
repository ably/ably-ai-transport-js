'use client';

import { useState, useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type * as Ably from 'ably';

interface DebugPaneProps {
  messages: UIMessage[];
  ablyMessages: Ably.InboundMessage[];
  activeTurns: Map<string, Set<string>>;
  status: string;
}

type Tab = 'ably' | 'uimessages';

function extractHeaders(msg: Ably.InboundMessage): Record<string, string> {
  const extras = msg.extras as { headers?: Record<string, string> } | undefined;
  return extras?.headers ?? {};
}

function AblyMessagesTab({ entries }: { entries: Ably.InboundMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-3 space-y-3"
    >
      {entries.length === 0 && (
        <p className="text-xs text-zinc-700 text-center mt-8">Raw Ably messages will appear here.</p>
      )}
      {entries.map((entry, idx) => {
        const headers = extractHeaders(entry);
        return (
          <div
            key={idx}
            className="rounded border border-zinc-800 bg-zinc-900/50 p-2 text-[11px] font-mono"
          >
            <div className="flex items-center gap-2 text-zinc-500 mb-1">
              <span className="text-zinc-600">#{idx}</span>
              <span>{new Date(entry.timestamp ?? Date.now()).toLocaleTimeString()}</span>
              <span className="text-emerald-500">{entry.name ?? '(unnamed)'}</span>
              <span className="text-amber-500">{String(entry.action ?? 'message.create')}</span>
            </div>
            {Object.keys(headers).length > 0 && (
              <div className="ml-2 mb-1 space-y-0.5">
                {Object.entries(headers).map(([k, v]) => (
                  <div
                    key={k}
                    className="text-zinc-600"
                  >
                    <span className="text-zinc-500">{k}</span>
                    <span className="text-zinc-700">: </span>
                    <span className="text-zinc-400">{v}</span>
                  </div>
                ))}
              </div>
            )}
            {entry.data !== undefined && entry.data !== null && (
              <div className="mt-1 text-zinc-600 break-all whitespace-pre-wrap">
                {typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function UIMessagesTab({
  messages,
  activeTurns,
  status,
}: {
  messages: UIMessage[];
  activeTurns: Map<string, Set<string>>;
  status: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const turnsDisplay =
    activeTurns.size > 0
      ? Array.from(activeTurns.entries())
          .map(
            ([cid, tids]) =>
              `${cid}: [${Array.from(tids)
                .map((t) => t.slice(0, 8))
                .join(', ')}]`,
          )
          .join('; ')
      : 'none';

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-3"
    >
      <div className="mb-3 flex gap-2">
        <div className="rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1.5 text-[10px]">
          <span className="text-zinc-600">useChat status: </span>
          <span
            className={`font-mono ${
              status === 'streaming' ? 'text-emerald-400' : status === 'submitted' ? 'text-amber-400' : 'text-zinc-600'
            }`}
          >
            {status}
          </span>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1.5 text-[10px]">
          <span className="text-zinc-600">Active turns: </span>
          <span className={`font-mono ${activeTurns.size > 0 ? 'text-blue-400' : 'text-zinc-600'}`}>
            {turnsDisplay}
          </span>
        </div>
      </div>
      {messages.length === 0 ? (
        <p className="text-xs text-zinc-700 text-center mt-8">Messages will appear here as JSON.</p>
      ) : (
        <pre className="text-[11px] leading-4 text-zinc-500 whitespace-pre-wrap break-all font-mono">
          {JSON.stringify(messages, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function DebugPane({ messages, ablyMessages, activeTurns, status }: DebugPaneProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('ably');

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed right-0 top-1/2 -translate-y-1/2 rounded-l-md bg-zinc-800 border border-r-0 border-zinc-700 px-1.5 py-3 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Show debug pane"
        >
          &lsaquo;
        </button>
      )}

      {isOpen && (
        <div className="w-[420px] flex-shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setTab('ably')}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
                  tab === 'ably' ? 'bg-zinc-800 text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'
                }`}
              >
                Ably Messages
                <span className="ml-1 text-zinc-600">{ablyMessages.length}</span>
              </button>
              <button
                onClick={() => setTab('uimessages')}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
                  tab === 'uimessages' ? 'bg-zinc-800 text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'
                }`}
              >
                UIMessages
                <span className="ml-1 text-zinc-600">{messages.length}</span>
              </button>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              close
            </button>
          </div>
          {tab === 'ably' ? (
            <AblyMessagesTab entries={ablyMessages} />
          ) : (
            <UIMessagesTab
              messages={messages}
              activeTurns={activeTurns}
              status={status}
            />
          )}
        </div>
      )}
    </>
  );
}
