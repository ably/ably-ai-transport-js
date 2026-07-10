'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useAblyMessages, useChatTransport, useMessageSync, useView } from '@ably/ai-transport/vercel/react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
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

import { FaultControls } from './components/fault-controls';
import { WdkProcessPanel } from './components/wdk-process-panel';
import { useClientTools } from './hooks/use-client-tools';
import type { FaultMode } from './lib/fault';

// The intro heading + blurb this durable demo shows above the transcript.
const INTRO_TITLE = 'Durable sessions on Vercel Workflows';
const INTRO_DESCRIPTION =
  'The same Ably-backed useChat client as the use-chat demo — but each turn runs on Vercel’s Workflow ' +
  'Development Kit. A durable workflow drives the agent loop across separate, retryable activity processes, ' +
  'each rebuilding the AIT run from the Ably channel. If an activity fails or its process dies, WDK re-runs it ' +
  'and AIT reconciles — no duplicate output, and the reply still lands over Ably. Each item below exercises a ' +
  'specific piece; try them in order.';

// COMMON_SCENARIOS order: server-weather[0], client-weather[1], approval-forecast[2],
// multi-tab[3], edit[4], regenerate[5], cancel[6], observability[7]. This demo drives
// the tool + sync + cancel + observability scenarios, and adds its own durable ones.
const SCENARIOS: readonly Scenario[] = [
  {
    // No built-in detector exists for a plain durable turn, so borrow the
    // retry-stock id (this demo drives no getStockPrice tool, so it never
    // completes) to keep the chip offered — a durable text turn is always worth
    // trying.
    id: 'retry-stock',
    tag: 'Durable text',
    title: 'Durable turn on a Workflow',
    prompt: 'Say "Hello from a durable Vercel Workflow!"',
    blurb:
      'Each turn runs as a Vercel Workflow. An open activity opens the AIT run, then a separate inference activity — ' +
      'a fresh process — runs the model and streams the reply. The badges under it show its run, step, and how many ' +
      'attempts the step took.',
  },
  {
    tag: 'Fault injection',
    title: 'Fault injection → durable retry',
    action: (
      <>
        Arm <span className="font-medium text-foreground">Fail once</span> or{' '}
        <span className="font-medium text-foreground">Crash</span> below, then send any prompt.
      </>
    ),
    blurb:
      'The activity throws on its first attempt; WDK re-runs it as a fresh process, and AIT’s stable step id makes ' +
      'the retry supersede the dead attempt — the conversation settles once, with no duplicate. Watch it happen in ' +
      'the WDK processes panel.',
  },
  COMMON_SCENARIOS[0], // server-weather
  COMMON_SCENARIOS[1], // client-weather
  COMMON_SCENARIOS[2], // approval-forecast
  {
    tag: 'WDK processes',
    title: 'WDK processes',
    gesture: 'watch the WDK processes panel on the right',
    blurb:
      'Every workflow and its activities appear as they run, correlated to the AIT run id, with WDK-side status ' +
      'polled from the real Workflow observability API.',
  },
  COMMON_SCENARIOS[6], // cancel
  COMMON_SCENARIOS[3], // multi-tab
  COMMON_SCENARIOS[7], // observability
];

// ---------------------------------------------------------------------------
// Chat component
// ---------------------------------------------------------------------------

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
    },
  );

  useMessageSync({ setMessages });

  // Track status transitions, annotating an `error` transition with the
  // accompanying error message useChat exposes alongside the status.
  useEffect(() => {
    setStatusLog((prev) => [
      ...prev,
      { time: Date.now(), status, error: status === 'error' ? error?.message : undefined },
    ]);
  }, [status, error]);

  // useChat.stop() targets the run it owns; Stop shows while it is mid-request.
  const isRunning = status === 'submitted' || status === 'streaming';

  // Auto-loads first page on mount.
  const { messages, hasOlder, loading, loadOlder, branchSelection, runOf } = useView({ limit: historyLimit ?? 30 });

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
    <ChatShell
      title="Ably AI Transport — Vercel WDK"
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
      extraSlot={
        <FaultControls
          fault={fault}
          onChange={armFault}
        />
      }
      transcript={
        <BranchingMessageList
          messages={messages}
          hasOlder={hasOlder}
          loading={loading}
          view={{ branchSelection, runOf }}
          onLoadOlder={loadOlder}
          scrollToEndRef={scrollToEndRef}
          scenarios={SCENARIOS}
          introTitle={INTRO_TITLE}
          introDescription={INTRO_DESCRIPTION}
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
        <>
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
        </>
      }
    />
  );
}
