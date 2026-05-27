'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { userMessage, userMessageEvent } from '../helpers';
import { useClientTools } from '../hooks/use-client-tools';
import { useDemoProgress } from '../hooks/use-demo-progress';
import { MessageList } from './message-list';
import { SuggestionChips } from './suggestion-chips';
import type { CallbackLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import { SessionHooks } from '../providers';
import { clientColor } from '../lib/client-color';

const { useClientSession, useActiveRuns, useView, useAblyMessages } = SessionHooks;

interface ChatProps {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
}

export function Chat({ clientId, historyLimit }: ChatProps) {
  const { session } = useClientSession();

  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
  }, []);

  const view = useView({ limit: historyLimit ?? 30 });
  const { nodes, hasOlder, loading, loadOlder, hasSiblings, getSiblings, getSelectedIndex, select } = view;

  useClientTools(view, clientId);

  const activeRuns = useActiveRuns();
  const hasAnyRuns = activeRuns.size > 0;
  const status = hasAnyRuns ? 'running' : 'idle';

  useEffect(() => {
    setStatusLog((prev) => [...prev, { time: Date.now(), status }]);
  }, [status]);

  useEffect(() => {
    const offRun = session.tree.on('run', (event) => {
      const summary =
        event.type === 'ai-run-start'
          ? `runId=${event.runId.slice(0, 8)}, clientId=${event.clientId}${event.isContinuation ? ', continuation' : ''}`
          : `runId=${event.runId.slice(0, 8)}, clientId=${event.clientId}, reason=${event.reason}`;
      setCallbackLog((prev) => [
        ...prev,
        {
          time: Date.now(),
          type: event.type === 'ai-run-start' ? 'runStart' : 'runEnd',
          summary,
        },
      ]);
    });
    const offErr = session.on('error', (error) => {
      setCallbackLog((prev) => [...prev, { time: Date.now(), type: 'error', summary: error.message }]);
    });
    return () => {
      offRun();
      offErr();
    };
  }, [session]);

  const ablyMessages = useAblyMessages();

  const unfinishedSteps = useDemoProgress(nodes, hasSiblings, ablyMessages);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  const handleToolApprove = useCallback(
    (codecMessageId: string, toolCallId: string) => {
      const node = view.getNode(codecMessageId);
      const runId = node?.headers['x-ably-run-id'];
      if (!runId) return;
      void view.sendEvent([{ type: 'tool-approval-response', toolCallId, approved: true }], { runId });
    },
    [view],
  );

  const handleToolDeny = useCallback(
    (codecMessageId: string, toolCallId: string) => {
      const node = view.getNode(codecMessageId);
      const runId = node?.headers['x-ably-run-id'];
      if (!runId) return;
      void view.sendEvent([{ type: 'tool-approval-response', toolCallId, approved: false, reason: 'User denied' }], {
        runId,
      });
    },
    [view],
  );

  const messages = useMemo(() => nodes.map((n) => n.message), [nodes]);

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header clientId={clientId} />
        <MessageList
          nodes={nodes}
          hasOlder={hasOlder}
          loading={loading}
          siblings={{ hasSiblings, getSiblings, getSelectedIndex, select }}
          onLoadOlder={() => void loadOlder()}
          onRegenerate={(codecMessageId) => void view.regenerate(codecMessageId)}
          onEdit={(codecMessageId, text) => void view.edit(codecMessageId, [userMessageEvent(text)])}
          onToolApprove={handleToolApprove}
          onToolDeny={handleToolDeny}
        />
        <div className="border-t border-zinc-800">
          <SuggestionChips
            steps={unfinishedSteps}
            onSelectPrompt={handleSelectPrompt}
          />
          <InputBar
            value={input}
            onChange={setInput}
            inputRef={inputRef}
            onSend={(text) => void view.sendMessage(userMessage(text))}
            onStop={() => {
              const ownRunIds = clientId ? activeRuns.get(clientId) : undefined;
              if (!ownRunIds) return;
              for (const runId of ownRunIds) void session.cancel(runId);
            }}
            hasAnyRuns={hasAnyRuns}
          />
        </div>
      </div>
      <DebugPane
        messages={messages}
        ablyMessages={ablyMessages}
        activeRuns={activeRuns}
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
    <header className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <h1 className="text-sm font-medium text-zinc-300">Ably AI — ClientSession</h1>
        </div>
        <div className="flex items-center gap-2 pl-4">
          <a
            href="https://github.com/ably/ably-ai-transport-js"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition-colors"
          >
            SDK repo
            <ExternalLinkIcon />
          </a>
          <a
            href="https://ably.com/docs/ai-transport"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition-colors"
          >
            Ably docs
            <ExternalLinkIcon />
          </a>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.delete('clientId');
            window.open(url.toString(), '_blank');
          }}
          className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          title="Open this channel in a new tab as a fresh client"
        >
          open in new tab
        </button>
        {clientId && <span className={`font-mono text-xs ${clientColor(clientId).text}`}>{clientId}</span>}
      </div>
    </header>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.75}
      stroke="currentColor"
      className="h-3 w-3"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Input bar — single Stop button when streaming, Send button otherwise
// ---------------------------------------------------------------------------

function InputBar({
  value,
  onChange,
  inputRef,
  onSend,
  onStop,
  hasAnyRuns,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onSend: (text: string) => void;
  onStop: () => void;
  hasAnyRuns: boolean;
}) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text) return;
    onChange('');
    onSend(text);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="px-4 py-3 flex gap-2"
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type a message..."
        className="flex-1 rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
        autoFocus
      />
      {hasAnyRuns ? (
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
          disabled={!value.trim()}
          className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      )}
    </form>
  );
}
