'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import type { UIMessage } from 'ai';
import { useAblyMessages, useChatTransport, useMessageSync } from '@ably/ai-transport/vercel/react';
import type { CodecMessage } from '@ably/ai-transport';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChatShell,
  COMMON_SCENARIOS,
  DebugPane,
  LinearMessageList,
  type CallbackLogEntry,
  type ClientToolLogEntry,
  type DemoStepId,
  type MessageStatus,
  type Scenario,
} from '@ably-ai-demos/frontend';
import { useClientTools } from '../hooks/use-client-tools';
import { useDemoProgress } from '../hooks/use-demo-progress';

// The scenarios this linear demo can drive: the shared baseline entries whose
// completion it can detect from a plain message list (server/client/approval
// tools and cancel), plus the intro-only Observability entry (no id). The
// branching-only scenarios (multi-tab, edit, regenerate) are excluded — this
// demo renders `useChat`'s linear messages with no Run/branch attribution, so
// they cannot be detected here.
const DRIVEN_IDS = new Set<DemoStepId>(['server-weather', 'client-weather', 'approval-forecast', 'cancel']);
const SCENARIOS: readonly Scenario[] = COMMON_SCENARIOS.filter((s) => s.id === undefined || DRIVEN_IDS.has(s.id));

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
  const statusOf = useCallback(
    (message: UIMessage, index: number): MessageStatus | undefined => {
      if (message.role !== 'assistant') return undefined;
      if (index === messages.length - 1) {
        if (streaming) return 'streaming';
        if (status === 'error') return 'error';
      }
      return 'complete';
    },
    [messages.length, streaming, status],
  );

  useClientTools(messages, addToolResult, recordClientTool);

  const ablyMessages = useAblyMessages();

  const unfinishedScenarios = useDemoProgress(SCENARIOS, messages, ablyMessages);

  // Connect (subscribe + attach) before offering the UI — `connect()` attaches
  // the channel, so the first send always lands on an attached channel rather
  // than rejecting with "channel is initialized".
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const connect = async (): Promise<void> => {
      try {
        await session.connect();
        if (!cancelled) setConnected(true);
      } catch {
        // Connect/attach errors surface via session.on('error'); leave the
        // shell gated behind the connecting notice.
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

  // ChatShell always renders its composer, so the pre-attach gate wraps the
  // whole shell: until the channel is attached, show the connecting notice in
  // place of the UI, mirroring the composer-level gate a bespoke shell would use.
  if (!connected) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Connecting channel…</div>
    );
  }

  // The debug pane renders raw messages from a codec-message-id pairing; this
  // linear demo has no View, so pair each UIMessage with its own domain id.
  const debugMessages: CodecMessage<UIMessage>[] = messages.map((m) => ({ codecMessageId: m.id, message: m }));

  return (
    <ChatShell
      title="Ably AI — Vercel UI SDK — DB hydration"
      channelName={chatId}
      clientId={clientId}
      input={input}
      onInputChange={setInput}
      inputRef={inputRef}
      onSend={handleSend}
      onStop={() => void stop()}
      isRunning={streaming}
      suggestions={unfinishedScenarios}
      onSelectPrompt={handleSelectPrompt}
      transcript={
        <LinearMessageList
          messages={messages}
          statusOf={statusOf}
          onToolApprove={(toolPart) => {
            const id = toolPart.approval?.id;
            if (id) addToolApprovalResponse({ id, approved: true });
          }}
          onToolDeny={(toolPart) => {
            const id = toolPart.approval?.id;
            if (id) addToolApprovalResponse({ id, approved: false, reason: 'User denied' });
          }}
          scrollToEndRef={scrollToEndRef}
          scenarios={SCENARIOS}
        />
      }
      debugPane={
        <DebugPane
          messages={debugMessages}
          ablyMessages={ablyMessages}
          status={status}
          callbackLog={callbackLog}
          statusLog={statusLog}
          clientToolLog={clientToolLog}
          onClearLogs={clearLogs}
        />
      }
    />
  );
}
