'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useAblyMessages } from '@ably/ai-transport/react';
import type { ChatTransport } from '@ably/ai-transport/vercel';
import type { UIMessage } from 'ai';
import { useCallback, useEffect, useState } from 'react';
import {
  Chat as ChatView,
  COMMON_SCENARIOS,
  hasClientTool,
  runClientTool,
  stopAndCancel,
  type CallbackLogEntry,
  type ClientToolLogEntry,
  type DemoStepId,
  type Scenario,
} from '@ably-ai-demos/frontend';
import { ChecklistWidget } from './components/checklist-widget';
import { useStoredHydration } from './hooks/use-stored-hydration';

// Pick shared scenarios by id, never by position: the shared list is edited
// independently of this demo, and an index would silently change what the
// demo offers (or drop off the end).
const pickShared = (...ids: DemoStepId[]): Scenario[] =>
  ids.flatMap((id) => COMMON_SCENARIOS.filter((scenario) => scenario.id === id));

// The shared baseline scenarios this linear demo demonstrates (tools,
// approvals, multi-client sync, cancel, observability) plus the LiveObjects
// checklist entry.
const SCENARIOS: readonly Scenario[] = [
  ...pickShared('server-weather', 'client-weather', 'approval-forecast'),
  {
    id: 'checklist',
    tag: 'LiveObjects checklist',
    title: 'LiveObjects checklist',
    prompt: 'write me a short blog post about Ably — outline it, draft it, then tidy it up',
    blurb:
      'The assistant plans a task checklist in Ably LiveObjects and flips each step to done as it works. The widget below the chat renders the live progress and restores it on reload.',
  },
  ...pickShared('multi-tab', 'cancel'),
  // Intro-only entries (no id, so never tracked or offered as a chip).
  ...COMMON_SCENARIOS.filter((scenario) => scenario.id === undefined),
];

/**
 * Hydrate the conversation from the server's store, then render the chat.
 *
 * The store is the whole record: the agent route writes it as each run opens
 * and again when the run's stream ends, so one `GET /api/messages` is the
 * conversation. Nothing pages channel history. The store also names a run
 * still streaming, which the chat resumes below — that is what makes
 * `resume: true` work on a page that just loaded and never watched the run
 * start.
 */
export function Chat({ chatId, clientId }: { chatId: string; clientId?: string }) {
  const state = useStoredHydration({ channelName: chatId });

  if (state.status === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
        Loading conversation&hellip;
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-red-400">
        Transport unavailable: {state.error.message}
      </div>
    );
  }

  return (
    <ChatInner
      chatId={chatId}
      clientId={clientId}
      chatTransport={state.chatTransport}
      initialMessages={state.initialMessages}
      activeRunId={state.activeRunId}
    />
  );
}

function ChatInner({
  chatId,
  clientId,
  chatTransport,
  initialMessages,
  activeRunId,
}: {
  chatId: string;
  clientId?: string;
  chatTransport: ChatTransport;
  initialMessages: UIMessage[];
  activeRunId: string | undefined;
}) {
  // -- Callback & status logging for the debug pane -------------------------
  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
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

  // useChat owns all message state from here: it starts from the stored
  // conversation, and the adapter turns its sends into channel publishes plus
  // the wake-the-agent POST, with the reply streaming back off the channel. A
  // run still streaming at page load is picked up by the resume effect below,
  // which passes its id as a reconnect hint.
  const { messages, sendMessage, stop, status, addToolOutput, addToolApprovalResponse, resumeStream } = useChat({
    id: chatId,
    transport: chatTransport,
    messages: initialMessages,
    // Auto-submit the continuation once addToolOutput resolves tool calls OR
    // addToolApprovalResponse resolves approvals. The resolution carries no
    // run id, so its POST wakes a fresh run that answers.
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
      if (!hasClientTool(toolCall.toolName)) return;
      // Execute the browser-side tool and feed the result back to useChat;
      // sendAutomaticallyWhen then POSTs the continuation.
      void runClientTool(toolCall.toolName, toolCall.toolCallId, toolCall.input, recordClientTool).then((result) => {
        if ('output' in result) {
          addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output: result.output });
        } else {
          addToolOutput({
            state: 'output-error',
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            errorText: result.errorText,
          });
        }
      });
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
      setCallbackLog((prev) => [...prev, { time: Date.now(), type: 'onError', summary: error.message }]);
    },
  });

  // Resume the run the store said was streaming. The hint names it directly,
  // so the adapter joins that run rather than guessing from what it has seen
  // — which on a page that just loaded is nothing. Runs once per hydrated run
  // id; a run that ends before this fires resumes to an already-closed stream,
  // which the adapter answers with no chunks.
  useEffect(() => {
    if (activeRunId === undefined) return;
    void resumeStream({ body: { runId: activeRunId } });
  }, [activeRunId, resumeStream]);

  // Track status transitions for the debug pane. Recording a history of an
  // external value's transitions is the intended use of this effect — it
  // observes useChat's status, it does not derive render state.
  useEffect(() => {
    setStatusLog((prev) => [...prev, { time: Date.now(), status }]);
  }, [status]);

  // Show Stop while useChat is mid-request (submitted before the stream
  // starts, streaming while chunks arrive).
  const isRunning = status === 'submitted' || status === 'streaming';

  const onStop = useCallback(() => void stopAndCancel(stop, chatTransport), [stop, chatTransport]);

  const ablyMessages = useAblyMessages();

  return (
    <ChatView
      chatId={chatId}
      clientId={clientId}
      headerTitle="Ably AI — Vercel useChat"
      scenarios={SCENARIOS}
      extraSlot={<ChecklistWidget />}
      messages={messages}
      isRunning={isRunning}
      onSend={(text) => sendMessage({ text })}
      onStop={onStop}
      onToolApprove={(toolPart) => {
        const id = toolPart.approval?.id;
        if (id) addToolApprovalResponse({ id, approved: true });
      }}
      onToolDeny={(toolPart) => {
        const id = toolPart.approval?.id;
        if (id) addToolApprovalResponse({ id, approved: false, reason: 'User denied' });
      }}
      ablyMessages={ablyMessages}
      callbackLog={callbackLog}
      clientToolLog={clientToolLog}
      statusLog={statusLog}
      onClearLogs={clearLogs}
    />
  );
}
