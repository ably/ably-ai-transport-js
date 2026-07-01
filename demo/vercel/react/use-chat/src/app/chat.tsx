'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useAblyMessages, useChatTransport, useMessageSync, useView } from '@ably/ai-transport/vercel/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageList } from './components/message-list';
import type { CallbackLogEntry, ClientToolLogEntry } from './components/debug-pane';
import { DebugPane } from './components/debug-pane';
import { ChecklistWidget } from './components/checklist-widget';
import { SuggestionChips } from './components/suggestion-chips';
import { useClientTools } from './hooks/use-client-tools';
import { useDemoProgress } from './hooks/use-demo-progress';
import { clientColor } from './lib/client-color';
import { AvatarStack } from './components/avatar-stack';

// ---------------------------------------------------------------------------
// Chat component
// ---------------------------------------------------------------------------

export function Chat({ chatId, clientId, historyLimit }: { chatId: string; clientId?: string; historyLimit?: number }) {
  // ChatTransport slot is created by ChatTransportProvider in page.tsx
  const { chatTransport, session } = useChatTransport();

  // -- Callback & status logging for debug pane ----------------------------
  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string; error?: string }[]>([]);
  const [clientToolLog, setClientToolLog] = useState<ClientToolLogEntry[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
    setClientToolLog([]);
  }, []);

  // Record client-side tool executions, keyed by toolCallId. Each onExecute
  // call carries a complete entry, so the `done` entry replaces the earlier
  // `executing` one in place.
  const recordClientTool = useCallback((entry: ClientToolLogEntry) => {
    setClientToolLog((prev) => {
      const idx = prev.findIndex((e) => e.toolCallId === entry.toolCallId);
      if (idx === -1) return [...prev, entry];
      const next = [...prev];
      next[idx] = entry;
      return next;
    });
  }, []);

  const { setMessages, sendMessage, stop, status, error, regenerate, addToolResult, addToolApprovalResponse } = useChat(
    {
      id: chatId,
      transport: chatTransport,
      // Auto-submit after addToolResult resolves tool calls OR
      // addToolApprovalResponse resolves approvals, so the assistant can
      // continue with the tool output / approved execution.
      sendAutomaticallyWhen: ({ messages: msgs }) =>
        lastAssistantMessageIsCompleteWithToolCalls({ messages: msgs }) ||
        lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
      onToolCall: ({ toolCall }) => {
        setCallbackLog((prev) => [
          ...prev,
          {
            time: Date.now(),
            type: 'onToolCall',
            summary: `${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
          },
        ]);
      },
      onFinish: ({ message, finishReason }) => {
        setCallbackLog((prev) => [
          ...prev,
          {
            time: Date.now(),
            type: 'onFinish',
            summary: `reason=${String(finishReason)}, parts=${String(message.parts.length)}`,
          },
        ]);
      },
      onError: (error) => {
        setCallbackLog((prev) => [
          ...prev,
          {
            time: Date.now(),
            type: 'onError',
            summary: error.message,
          },
        ]);
      },
    },
  );

  useMessageSync({ setMessages });

  // Track status transitions, annotating an `error` transition with the
  // accompanying error message useChat exposes alongside the status.
  useEffect(() => {
    setStatusLog((prev) => [
      ...prev,
      { time: Date.now(), status, error: status === 'error' ? error?.message : undefined },
    ]);
  }, [status, error]);

  // Show Stop while useChat is mid-request (submitted before stream starts,
  // streaming while chunks arrive). useChat.stop() targets the run it owns.
  const hasAnyRuns = status === 'submitted' || status === 'streaming';

  // Auto-loads first page on mount
  const { messages, hasOlder, loading, loadOlder, branchSelection, runOf } = useView({
    limit: historyLimit ?? 30,
  });

  useClientTools(session, messages, addToolResult, runOf, clientId, recordClientTool);

  const ablyMessages = useAblyMessages();

  const unfinishedSteps = useDemoProgress(messages, runOf, branchSelection, ablyMessages);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header
          clientId={clientId}
          channelName={chatId}
        />
        <MessageList
          messages={messages}
          hasOlder={hasOlder}
          loading={loading}
          view={{
            branchSelection,
            runOf,
          }}
          onLoadOlder={loadOlder}
          onRegenerate={(messageId) => regenerate({ messageId })}
          onEdit={(messageId, text) => sendMessage({ text, messageId })}
          onToolApprove={(approvalId) => addToolApprovalResponse({ id: approvalId, approved: true })}
          onToolDeny={(approvalId) =>
            addToolApprovalResponse({ id: approvalId, approved: false, reason: 'User denied' })
          }
        />
        <ChecklistWidget session={session} />
        <div className="border-t border-zinc-800">
          <SuggestionChips
            steps={unfinishedSteps}
            onSelectPrompt={handleSelectPrompt}
          />
          <InputBar
            value={input}
            onChange={setInput}
            inputRef={inputRef}
            onSend={(text) => sendMessage({ text })}
            onStop={stop}
            hasAnyRuns={hasAnyRuns}
          />
        </div>
      </div>
      <DebugPane
        messages={messages}
        ablyMessages={ablyMessages}
        status={status}
        callbackLog={callbackLog}
        statusLog={statusLog}
        clientToolLog={clientToolLog}
        onClearLogs={clearLogs}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ clientId, channelName }: { clientId?: string; channelName: string }) {
  return (
    <header className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <h1 className="text-sm font-medium text-zinc-300">Ably AI — Vercel UI SDK</h1>
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
      <div className="ml-auto flex items-center gap-3">
        <AvatarStack
          channelName={channelName}
          selfClientId={clientId}
        />
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
