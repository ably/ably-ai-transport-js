'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useAblyMessages, useChatTransport, useMessageSync, useView } from '@ably/ai-transport/vercel/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, ExternalLinkIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
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
  // accompanying error message useChat exposes alongside the status. Recording
  // a history of an external value's transitions is the intended use of this
  // effect — it observes useChat's status, it does not derive render state.
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
        <div className="border-t border-border">
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
    <header className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {/* Liveness indicator — no semantic "online" token exists, so a
              fixed status colour is intentional here. */}
          <div className="size-2 rounded-full bg-emerald-500" />
          <h1 className="text-sm font-medium text-foreground">Ably AI — Vercel UI SDK</h1>
        </div>
        <div className="flex items-center gap-2 pl-4">
          <Button
            asChild
            variant="outline"
            size="xs"
            className="rounded-full"
          >
            <a
              href="https://github.com/ably/ably-ai-transport-js"
              target="_blank"
              rel="noreferrer"
            >
              SDK repo
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </Button>
          <Button
            asChild
            variant="outline"
            size="xs"
            className="rounded-full"
          >
            <a
              href="https://ably.com/docs/ai-transport"
              target="_blank"
              rel="noreferrer"
            >
              Ably docs
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </Button>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <AvatarStack
          channelName={channelName}
          selfClientId={clientId}
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.delete('clientId');
            window.open(url.toString(), '_blank');
          }}
          title="Open this channel in a new tab as a fresh client"
        >
          open in new tab
        </Button>
        {clientId && <span className={`font-mono text-xs ${clientColor(clientId).text}`}>{clientId}</span>}
      </div>
    </header>
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
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string) => void;
  onStop: () => void;
  hasAnyRuns: boolean;
}) {
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onChange('');
    onSend(text);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="px-4 py-3"
    >
      <InputGroup>
        <InputGroupTextarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type a message..."
          autoFocus
          rows={1}
          className="min-h-0"
          // Enter sends; Shift+Enter inserts a newline (standard composer UX).
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          {hasAnyRuns ? (
            <InputGroupButton
              type="button"
              variant="destructive"
              size="icon-sm"
              className="rounded-full"
              aria-label="Stop"
              onClick={onStop}
            >
              <SquareIcon className="fill-current" />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-sm"
              className="rounded-full"
              aria-label="Send"
              disabled={!value.trim()}
            >
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
