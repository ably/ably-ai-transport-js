'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useAblyMessages, useChatTransport, useMessageSync, useView } from '@ably/ai-transport/vercel/react';
import { type FormEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { AvatarStack } from './components/avatar-stack';
import type { CallbackLogEntry, ClientToolLogEntry } from './components/debug-pane';
import { DebugPane } from './components/debug-pane';
import { FaultControls } from './components/fault-controls';
import { MessageList } from './components/message-list';
import { SuggestionChips } from './components/suggestion-chips';
import { WdkProcessPanel } from './components/wdk-process-panel';
import { useClientTools } from './hooks/use-client-tools';
import { clientColor } from './lib/client-color';
import type { FaultMode } from './lib/fault';

export function Chat({
  chatId,
  clientId,
  historyLimit,
  faultRef,
}: {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
  faultRef: RefObject<FaultMode | undefined>;
}) {
  // The ChatTransport + underlying ClientSession are created by
  // ChatTransportProvider in page.tsx. The client is identical to the non-durable
  // `use-chat` demo — only the server execution model (Vercel Workflows) differs.
  const { chatTransport, session } = useChatTransport();

  // -- Callback & status logging for the debug pane ------------------------
  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string; error?: string }[]>([]);
  const [clientToolLog, setClientToolLog] = useState<ClientToolLogEntry[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
    setClientToolLog([]);
  }, []);

  const recordClientTool = useCallback((entry: ClientToolLogEntry) => {
    setClientToolLog((prev) => {
      const idx = prev.findIndex((e) => e.toolCallId === entry.toolCallId);
      if (idx === -1) return [...prev, entry];
      const next = [...prev];
      next[idx] = entry;
      return next;
    });
  }, []);

  const { setMessages, sendMessage, stop, status, error, addToolResult, addToolApprovalResponse } = useChat({
    id: chatId,
    transport: chatTransport,
    // Auto-submit a continuation once a client-side tool result or a server-tool
    // approval resolves, so the suspended run resumes (on a fresh workflow).
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages: msgs }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
    onToolCall: ({ toolCall }) => {
      setCallbackLog((prev) => [
        ...prev,
        { time: Date.now(), type: 'onToolCall', summary: `${toolCall.toolName}(${JSON.stringify(toolCall.input)})` },
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
    onError: (err) => {
      setCallbackLog((prev) => [...prev, { time: Date.now(), type: 'onError', summary: err.message }]);
    },
  });

  useMessageSync({ setMessages });

  useEffect(() => {
    setStatusLog((prev) => [
      ...prev,
      { time: Date.now(), status, error: status === 'error' ? error?.message : undefined },
    ]);
  }, [status, error]);

  // useChat.stop() targets the run it owns; Stop shows while it is mid-request.
  const isStreaming = status === 'submitted' || status === 'streaming';

  const { messages, hasOlder, loading, loadOlder, runOf } = useView({ limit: historyLimit ?? 30 });

  useClientTools(session, messages, addToolResult, runOf, clientId, recordClientTool);

  const ablyMessages = useAblyMessages();

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  // Armed fault for the next turn. Mirrored into `faultRef` so the transport's
  // prepareSendMessagesRequest (created in page.tsx) reads the current value.
  const [fault, setFault] = useState<FaultMode | undefined>(undefined);
  const armFault = useCallback(
    (next: FaultMode | undefined) => {
      setFault(next);
      faultRef.current = next;
    },
    [faultRef],
  );

  // The transport consumes the armed fault with the send that carries it
  // (one-shot — see page.tsx); disarm the toggle visually to match.
  useEffect(() => {
    if (status === 'submitted') setFault(undefined);
  }, [status]);

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
          view={{ runOf }}
          onLoadOlder={loadOlder}
          onToolApprove={(approvalId) => addToolApprovalResponse({ id: approvalId, approved: true })}
          onToolDeny={(approvalId) =>
            addToolApprovalResponse({ id: approvalId, approved: false, reason: 'User denied' })
          }
        />
        <div className="border-t border-zinc-800">
          <FaultControls
            fault={fault}
            onChange={armFault}
          />
          <SuggestionChips onSelectPrompt={handleSelectPrompt} />
          <InputBar
            value={input}
            onChange={setInput}
            inputRef={inputRef}
            onSend={(text) => sendMessage({ text })}
            onStop={stop}
            isStreaming={isStreaming}
          />
        </div>
      </div>
      <WdkProcessPanel channelName={chatId} />
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

function Header({ clientId, channelName }: { clientId?: string; channelName: string }) {
  return (
    <header className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <h1 className="text-sm font-medium text-zinc-300">Ably AI Transport — Vercel WDK</h1>
        </div>
        <div className="flex items-center gap-2 pl-4">
          <a
            href="https://github.com/ably/ably-ai-transport-js"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
          >
            SDK repo
            <ExternalLinkIcon />
          </a>
          <a
            href="https://ably.com/docs/ai-transport"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
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
          className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
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

function InputBar({
  value,
  onChange,
  inputRef,
  onSend,
  onStop,
  isStreaming,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
}) {
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text) return;
    onChange('');
    onSend(text);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-2 px-4 py-3"
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Type a message..."
        className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={onStop}
          className="rounded-md bg-red-900/60 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900/80"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={!value.trim()}
          className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      )}
    </form>
  );
}
