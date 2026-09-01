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
  useChannelHydration,
  type CallbackLogEntry,
  type ClientToolLogEntry,
  type DemoStepId,
  type Scenario,
} from '@ably-ai-demos/frontend';
import { ChecklistWidget } from './components/checklist-widget';

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
 * Hydrate the conversation from the channel, then render the chat.
 *
 * This demo keeps no store: the channel is the whole record, so the walk runs
 * with no serial and covers it end to end. Running it is also what makes
 * `resume: true` work — `readSince` withholds a run that has not ended and
 * retains its events for `reconnectToStream`, and without that a page that
 * just loaded can only resume a run it watched start live, which it never
 * did.
 */
export function Chat({ chatId, clientId }: { chatId: string; clientId?: string }) {
  const state = useChannelHydration();

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
    />
  );
}

function ChatInner({
  chatId,
  clientId,
  chatTransport,
  initialMessages,
}: {
  chatId: string;
  clientId?: string;
  chatTransport: ChatTransport;
  initialMessages: UIMessage[];
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

  // useChat owns all message state from here: it starts from the hydrated
  // conversation, and the adapter turns its sends into channel publishes plus
  // the wake-the-agent POST, with the reply streaming back off the channel.
  // `resume: true` reconnects to a run still streaming after a reload, via the
  // adapter's reconnectToStream.
  const { messages, sendMessage, stop, status, addToolOutput, addToolApprovalResponse } = useChat({
    id: chatId,
    transport: chatTransport,
    messages: initialMessages,
    resume: true,
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
