'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useAblyMessages } from '@ably/ai-transport/react';
import { useChatTransport } from '@ably/ai-transport/vercel/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Chat as ChatView,
  hasClientTool,
  runClientTool,
  type CallbackLogEntry,
  type ClientToolLogEntry,
} from '@ably-ai-demos/frontend';

import { TEMPORAL_SCENARIOS, TEMPORAL_INTRO_TITLE, TEMPORAL_INTRO_DESCRIPTION } from './demo-content';

/**
 * The demo's chat: `useChat` over the Ably chat transport is the only message
 * state. The transport publishes each send on the channel and POSTs the
 * invocation pointer to `/api/chat`, which starts the Temporal workflow; the
 * reply streams back over the same channel. `resume: true` reconnects to a run
 * that is still streaming when the page loads.
 */
export function Chat({ chatId, clientId }: { chatId: string; clientId?: string }) {
  const { chatTransport, error } = useChatTransport();

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

  // onToolCall fires inside useChat's options, before the hook has returned
  // its helpers — reach the current addToolOutput through a ref.
  const addToolOutputRef = useRef<ReturnType<typeof useChat>['addToolOutput'] | null>(null);

  const chat = useChat({
    id: chatId,
    transport: chatTransport,
    // Reconnect to a run that is still streaming when this page loads.
    resume: true,
    // Auto-submit after addToolOutput resolves tool calls OR
    // addToolApprovalResponse resolves approvals. The resolution carries no
    // run id, so its continuation POST starts a fresh workflow on a new run.
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages: msgs }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
    onToolCall: async ({ toolCall }) => {
      setCallbackLog((prev) => [
        ...prev,
        {
          time: Date.now(),
          type: 'onToolCall',
          summary: `${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
        },
      ]);
      // Server tools run in the worker; only browser-executed tools resolve here.
      if (!hasClientTool(toolCall.toolName)) return;
      const result = await runClientTool(toolCall.toolName, toolCall.toolCallId, toolCall.input, recordClientTool);
      const addToolOutput = addToolOutputRef.current;
      if (!addToolOutput) return;
      if ('output' in result) {
        void addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output: result.output });
      } else {
        void addToolOutput({
          state: 'output-error',
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          errorText: result.errorText,
        });
      }
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
    onError: (chatError) => {
      setCallbackLog((prev) => [
        ...prev,
        {
          time: Date.now(),
          type: 'onError',
          summary: chatError.message,
        },
      ]);
    },
  });

  useEffect(() => {
    addToolOutputRef.current = chat.addToolOutput;
  }, [chat.addToolOutput]);

  // Track status transitions, annotating an `error` transition with the
  // accompanying error message useChat exposes alongside the status.
  useEffect(() => {
    setStatusLog((prev) => [
      ...prev,
      {
        time: Date.now(),
        status: chat.status === 'error' ? `error: ${chat.error?.message ?? 'unknown'}` : chat.status,
      },
    ]);
  }, [chat.status, chat.error]);

  // Show Stop while useChat is mid-request (submitted before stream starts,
  // streaming while chunks arrive).
  const isRunning = chat.status === 'submitted' || chat.status === 'streaming';

  // Stop is two operations. `stop()` closes this client's stream; only
  // `chatTransport.cancel()` puts `ai-cancel` on the channel, which is what
  // aborts the running activity and tells every other participant the run is
  // over.
  const cancelRun = useCallback(async () => {
    await chat.stop();
    await chatTransport?.cancel();
  }, [chat, chatTransport]);

  const ablyMessages = useAblyMessages();

  if (error) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-destructive">
        Transport error: {error.message}
      </div>
    );
  }

  return (
    <ChatView
      chatId={chatId}
      clientId={clientId}
      headerTitle={TEMPORAL_INTRO_TITLE}
      introTitle={TEMPORAL_INTRO_TITLE}
      introDescription={TEMPORAL_INTRO_DESCRIPTION}
      scenarios={TEMPORAL_SCENARIOS}
      messages={chat.messages}
      isRunning={isRunning}
      onSend={(text) => {
        void chat.sendMessage({ text });
      }}
      onStop={() => void cancelRun()}
      onToolApprove={(toolPart) => {
        const id = toolPart.approval?.id;
        if (id) void chat.addToolApprovalResponse({ id, approved: true });
      }}
      onToolDeny={(toolPart) => {
        const id = toolPart.approval?.id;
        if (id) void chat.addToolApprovalResponse({ id, approved: false, reason: 'User denied' });
      }}
      ablyMessages={ablyMessages}
      callbackLog={callbackLog}
      clientToolLog={clientToolLog}
      statusLog={statusLog}
      onClearLogs={clearLogs}
    />
  );
}
