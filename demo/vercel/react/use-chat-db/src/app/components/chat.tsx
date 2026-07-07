'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import type { UIMessage } from 'ai';
import { useAblyMessages, useChatTransport, useMessageSync } from '@ably/ai-transport/vercel/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, ExternalLinkIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { MessageList } from './message-list';
import type { MessageState } from './message-bubble';
import type { CallbackLogEntry, ClientToolLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import { SuggestionChips } from './suggestion-chips';
import { useClientTools } from '../hooks/use-client-tools';
import { useDemoProgress } from '../hooks/use-demo-progress';
import { clientColor } from '../lib/client-color';
import { AvatarStack } from './avatar-stack';

// ---------------------------------------------------------------------------
// Chat component
// ---------------------------------------------------------------------------

/** Props for {@link Chat}. */
export interface ChatProps {
  /** The conversation id (the channel name); also `useChat`'s `id`. */
  chatId: string;
  /** This client's own clientId, shown in the header and avatar stack. */
  clientId?: string;
  /** The persisted conversation loaded from the database, used to seed `useChat`. */
  seed: UIMessage[];
}

/**
 * A linear chat that seeds `useChat` from the database and reconciles it with
 * the live channel via `useMessageSync`: the agent persists each completed run
 * to the store, and on load the stored conversation renders immediately while
 * the live channel is stitched on at the seam with no duplicate. It renders
 * straight from `useChat`'s `messages` (no branch navigation), so the seam-walk
 * in `useMessageSync` is the sole driver of channel history — the precondition
 * the single-overlap seam compose relies on.
 *
 * Despite being linear, it keeps the full tool surface of the sibling `use-chat`
 * demo: a server tool (getWeather), a client-executed tool that suspends and
 * resumes the run (getLocation), and an approval-gated tool (getWeatherForecast).
 * @param props - The conversation id, this client's id, and the database seed.
 */
export function Chat({ chatId, clientId, seed }: ChatProps): React.ReactElement {
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

  const { messages, setMessages, sendMessage, stop, status, error, addToolResult, addToolApprovalResponse } = useChat({
    id: chatId,
    transport: chatTransport,
    messages: seed,
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
  });

  // Reconcile the database seed with the live channel: take the newest seed id
  // as the seam, page the channel back to it, and compose seed ⧺ live tail.
  // Pass the stable `seed` prop (not useChat's live `messages`): useMessageSync
  // writes the reconciled result back via setMessages, so feeding `messages`
  // back in as the seed would churn its reference every push and loop. The seed
  // is the fixed page-load history; new runs arrive through the live channel.
  useMessageSync({ messages: seed, setMessages });

  // Track status transitions, annotating an `error` transition with the
  // accompanying error message useChat exposes alongside the status.
  useEffect(() => {
    setStatusLog((prev) => [
      ...prev,
      { time: Date.now(), status, error: status === 'error' ? error?.message : undefined },
    ]);
  }, [status, error]);

  // useChat's status reflects the in-flight request: 'submitted'/'streaming'
  // while a response is arriving, 'error' on failure, 'ready' when idle. The
  // live state applies to the last assistant message; earlier ones are done.
  const streaming = status === 'submitted' || status === 'streaming';
  const stateOf = useCallback(
    (message: UIMessage, index: number): MessageState => {
      if (message.role !== 'assistant') return undefined;
      if (index === messages.length - 1) {
        if (streaming) return 'streaming';
        if (status === 'error') return 'error';
      }
      return 'completed';
    },
    [messages.length, streaming, status],
  );

  useClientTools(messages, addToolResult, recordClientTool);

  const ablyMessages = useAblyMessages();

  const unfinishedSteps = useDemoProgress(messages, ablyMessages);

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Snap-to-live-edge callback published by the transcript; sending always
  // jumps to the bottom so the new turn and its streamed reply are in view.
  const scrollToEndRef = useRef<(() => void) | null>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      scrollToEndRef.current?.();
      // Linear history: a new run cancels any still-streaming response first, so
      // the seam reconciliation only ever meets complete (or cancelled) runs.
      void (async () => {
        if (streaming) await stop();
        await sendMessage({ text });
      })();
    },
    [streaming, stop, sendMessage],
  );

  return (
    // The app is a fixed full-viewport shell: clamp any stray overflow so the
    // page itself never grows scrollbars, and let the main column shrink below
    // its content's intrinsic width.
    <div className="flex h-dvh overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          clientId={clientId}
          channelName={chatId}
        />
        <MessageList
          messages={messages}
          stateOf={stateOf}
          onToolApprove={(approvalId) => addToolApprovalResponse({ id: approvalId, approved: true })}
          onToolDeny={(approvalId) =>
            addToolApprovalResponse({ id: approvalId, approved: false, reason: 'User denied' })
          }
          scrollToEndRef={scrollToEndRef}
        />
        <div className="border-t border-border">
          <SuggestionChips
            steps={unfinishedSteps}
            onSelectPrompt={handleSelectPrompt}
          />
          {connected ? (
            <InputBar
              value={input}
              onChange={setInput}
              inputRef={inputRef}
              onSend={handleSend}
              onStop={() => void stop()}
              streaming={streaming}
            />
          ) : (
            <div className="px-4 py-3 text-sm text-muted-foreground">Connecting channel…</div>
          )}
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
          <h1 className="text-sm font-medium text-foreground">Ably AI — Vercel UI SDK — DB hydration</h1>
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
  streaming,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
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
          {streaming ? (
            <InputGroupButton
              type="button"
              data-testid="stop"
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
