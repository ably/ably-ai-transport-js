'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useAblyMessages } from '@ably/ai-transport/react';
import type { ChatTransport } from '@ably/ai-transport/vercel';
import type { UIMessage } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { StoredConversation } from './lib/message-store';

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
 * Hydrate the conversation, then render the chat.
 *
 * Two sources, joined on a channel serial. The server's store answers with the
 * messages it holds and the serial they are complete up to, and
 * `chatTransport.readSince(latestSerial)` walks the channel back only as far
 * as that serial and returns whatever was published since. `useChannelHydration`
 * runs both and hands over the two lists joined, deduped by message id — the
 * store winning, since its watermark is a lower bound rather than an exact
 * seam.
 *
 * The walk is what makes a run still streaming resumable. `readSince`
 * withholds any message whose run has not ended and retains its events, so
 * `resumeStream()` below replays that message and continues live — one
 * producer per message, which is what the reducer needs.
 *
 * `resume: true` is deliberately not passed. It fires on mount, before the
 * fetch and the walk have run, and a reconnect with nothing retained has no
 * run to resume.
 */
export function Chat({ chatId, clientId }: { chatId: string; clientId?: string }) {
  const state = useChannelHydration({
    loadStored: async () => {
      const response = await fetch(`/api/messages?channelName=${encodeURIComponent(chatId)}`);
      if (!response.ok) {
        throw new Error(`messages request failed with status ${String(response.status)}`);
      }
      // CAST: trust boundary — the response body is our own messages route's
      // JSON, which serves the store verbatim.
      const stored = (await response.json()) as StoredConversation;
      return {
        messages: stored.messages,
        ...(stored.latestSerial === undefined ? {} : { latestSerial: stored.latestSerial }),
      };
    },
  });

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
  // conversation (the store plus the walk), and the adapter turns its sends
  // into channel publishes plus the wake-the-agent POST, with the reply
  // streaming back off the channel. A run still streaming at page load is
  // picked up by the resume effect below.
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

  // useChat hands back a fresh `resumeStream` identity every render, and
  // resuming sets status, so an effect that depends on it re-runs forever.
  // Read it through a ref instead and let the effects below own when they fire.
  const resumeStreamRef = useRef(resumeStream);
  useEffect(() => {
    resumeStreamRef.current = resumeStream;
  });

  // Step five of hydration, once per mount: pick up whatever the walk
  // withheld. The walk has already run by the time this component mounts, so
  // the adapter holds the in-flight message and takes its run id off that
  // message's own header. With nothing in flight this is a no-op — the adapter
  // answers `null`.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    void resumeStreamRef.current();
  }, []);

  // A run this client did not start. useChat accepts new streamed content only
  // through resumeStream(), so an idle tab has to ask for another
  // participant's run explicitly or it renders nothing while they chat. The
  // adapter fires this only while idle, so it cannot fight our own send.
  useEffect(() => chatTransport.onForeignRun(() => void resumeStreamRef.current()), [chatTransport]);

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
