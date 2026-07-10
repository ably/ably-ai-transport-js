'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useAblyMessages, useChatTransport, useMessageSync, useView } from '@ably/ai-transport/vercel/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BranchingMessageList,
  ChatShell,
  COMMON_SCENARIOS,
  DebugPane,
  useDemoProgress,
  type CallbackLogEntry,
  type ClientToolLogEntry,
  type Scenario,
} from '@ably-ai-demos/frontend';
import { ChecklistWidget } from './components/checklist-widget';
import { useClientTools } from './hooks/use-client-tools';

// The shared baseline scenarios plus the LiveObjects checklist entry this demo
// demonstrates. One scenario feeds both the intro card and the suggestion chip.
const SCENARIOS: readonly Scenario[] = [
  ...COMMON_SCENARIOS.slice(0, 3),
  {
    id: 'checklist',
    tag: 'LiveObjects checklist',
    title: 'LiveObjects checklist',
    prompt: 'write me a short blog post about Ably — outline it, draft it, then tidy it up',
    blurb:
      'The assistant plans a task checklist in Ably LiveObjects and flips each step to done as it works. The widget below the chat renders the live progress and restores it on reload.',
  },
  ...COMMON_SCENARIOS.slice(3),
];

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
  const isRunning = status === 'submitted' || status === 'streaming';

  // Auto-loads first page on mount
  const { messages, hasOlder, loading, loadOlder, branchSelection, runOf } = useView({
    limit: historyLimit ?? 30,
  });

  useClientTools(session, messages, addToolResult, runOf, clientId, recordClientTool);

  const ablyMessages = useAblyMessages();

  const unfinishedScenarios = useDemoProgress(SCENARIOS, messages, branchSelection, runOf, ablyMessages);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Snap-to-live-edge callback published by the transcript; sending always
  // jumps to the bottom so the new turn and its streamed reply are in view.
  const scrollToEndRef = useRef<(() => void) | null>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  return (
    <ChatShell
      title="Ably AI — Vercel UI SDK"
      channelName={chatId}
      clientId={clientId}
      input={input}
      onInputChange={setInput}
      inputRef={inputRef}
      onSend={(text) => {
        scrollToEndRef.current?.();
        sendMessage({ text });
      }}
      onStop={stop}
      isRunning={isRunning}
      suggestions={unfinishedScenarios}
      onSelectPrompt={handleSelectPrompt}
      extraSlot={<ChecklistWidget session={session} />}
      transcript={
        <BranchingMessageList
          messages={messages}
          hasOlder={hasOlder}
          loading={loading}
          view={{ branchSelection, runOf }}
          onLoadOlder={loadOlder}
          scrollToEndRef={scrollToEndRef}
          scenarios={SCENARIOS}
          onRegenerate={(cm) => regenerate({ messageId: cm.message.id })}
          onEdit={(cm, text) => sendMessage({ text, messageId: cm.message.id })}
          onToolApprove={(_cm, toolPart) => {
            const id = toolPart.approval?.id;
            if (id) addToolApprovalResponse({ id, approved: true });
          }}
          onToolDeny={(_cm, toolPart) => {
            const id = toolPart.approval?.id;
            if (id) addToolApprovalResponse({ id, approved: false, reason: 'User denied' });
          }}
        />
      }
      debugPane={
        <DebugPane
          messages={messages}
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
