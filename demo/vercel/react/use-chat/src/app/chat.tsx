'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useChatTransport } from '@ably/ai-transport/vercel/react';
import { useAblyMessages } from '@ably/ai-transport/react';
import type { ChatTransport } from '@ably/ai-transport/vercel';
import { useCallback, useEffect, useState } from 'react';
import {
  Chat as ChatView,
  COMMON_SCENARIOS,
  hasClientTool,
  runClientTool,
  type CallbackLogEntry,
  type ClientToolLogEntry,
  type Scenario,
} from '@ably-ai-demos/frontend';
import { ChecklistWidget } from './components/checklist-widget';

// The shared baseline scenarios this linear demo demonstrates (tools,
// approvals, cancel, observability) plus the LiveObjects checklist entry.
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
  ...COMMON_SCENARIOS.slice(6),
];

/**
 * Resolve the useChat adapter from the enclosing ChatTransportProvider, and
 * render the chat once it exists. A construction error renders in place of
 * the chat.
 */
export function Chat({ chatId, clientId }: { chatId: string; clientId?: string }) {
  const { chatTransport, error } = useChatTransport();

  if (!chatTransport) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-red-400">
        Transport unavailable{error ? `: ${error.message}` : ''}
      </div>
    );
  }

  return (
    <ChatInner
      chatId={chatId}
      clientId={clientId}
      chatTransport={chatTransport}
    />
  );
}

function ChatInner({
  chatId,
  clientId,
  chatTransport,
}: {
  chatId: string;
  clientId?: string;
  chatTransport: ChatTransport;
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

  // This demo does no history hydration — useChat's live stream is the only
  // message source. The empty seed opens the adapter's live event indexing,
  // which it holds back until seeded, so a tool continuation can address the
  // streamed assistant's wire identity.
  useEffect(() => {
    chatTransport.seed([]);
  }, [chatTransport]);

  // useChat owns all message state; the adapter turns its sends into channel
  // publishes plus the wake-the-agent POST, and its streams come off the
  // channel. `resume: true` reconnects to a live run after a reload via the
  // adapter's reconnectToStream.
  const { messages, sendMessage, stop, status, addToolOutput, addToolApprovalResponse } = useChat({
    id: chatId,
    transport: chatTransport,
    resume: true,
    // Auto-submit the continuation once addToolOutput resolves tool calls OR
    // addToolApprovalResponse resolves approvals, so the suspended run resumes.
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
  // starts, streaming while chunks arrive). useChat.stop() cancels the run.
  const isRunning = status === 'submitted' || status === 'streaming';

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
      onStop={() => void stop()}
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
