'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useAblyMessages } from '@ably/ai-transport/react';
import type { ChatTransport } from '@ably/ai-transport/vercel';
import type { UIMessage } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Chat as ChatContainer,
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

import { FaultControls } from './components/fault-controls';
import { WdkProcessPanel } from './components/wdk-process-panel';
import { FAULT_COOKIE, type FaultMode } from './lib/fault';

// The intro heading + blurb this durable demo shows above the transcript.
const INTRO_TITLE = 'Durable agents on Vercel Workflows';
const INTRO_DESCRIPTION =
  'The same Ably-backed useChat client as the use-chat demo — but each turn runs on Vercel’s Workflow ' +
  'Development Kit. A durable workflow drives the agent loop across separate, retryable activity processes, ' +
  'each rebuilding the AIT run from the Ably channel. If an activity fails or its process dies, WDK re-runs it ' +
  'and AIT reconciles — no duplicate output, and the reply still lands over Ably. Each item below exercises a ' +
  'specific piece; try them in order.';

// Pick shared scenarios by id, never by position: the shared list is edited
// independently of this demo, and an index would silently change what the
// demo offers (or drop off the end).
const pickShared = (...ids: DemoStepId[]): Scenario[] =>
  ids.flatMap((id) => COMMON_SCENARIOS.filter((scenario) => scenario.id === id));

/** The shared entries that are intro-only (no id, so never tracked or offered as a chip). */
const sharedIntroOnly = COMMON_SCENARIOS.filter((scenario) => scenario.id === undefined);

// This demo drives the tool + cancel + observability scenarios, and adds its
// own durable ones.
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
      'a fresh process — runs the model and streams the reply over the Ably channel.',
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
      'The activity throws on its first attempt; WDK re-runs it as a fresh process, and AIT’s pinned run id and ' +
      'stable step id make the retry re-enter the same run — the conversation settles once, with no duplicate. ' +
      'Watch it happen in the WDK processes panel.',
  },
  ...pickShared('server-weather', 'client-weather', 'approval-forecast'),
  {
    tag: 'WDK processes',
    title: 'WDK processes',
    gesture: 'watch the WDK processes panel on the right',
    blurb:
      'Every workflow and its activities appear as they run, correlated to the AIT run id, with WDK-side status ' +
      'polled from the real Workflow observability API.',
  },
  ...pickShared('cancel'),
  ...sharedIntroOnly,
];

/**
 * The outer component hydrates from the channel and only mounts the chat once
 * that resolves — useChat needs a transport and its initial messages at first
 * render, and a construction failure renders as an error notice instead.
 *
 * This demo keeps no store, so the walk covers the whole channel. Running it
 * is also what makes `resume: true` work: `readSince` withholds a run that has
 * not ended and retains its events for `reconnectToStream`, and without that a
 * page that just loaded can only resume a run it watched start live.
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
      <div className="flex h-dvh items-center justify-center text-sm text-destructive">
        Unable to create the chat transport: {state.error.message}
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

  // onToolCall fires while the send's stream is still being consumed; the
  // helpers it needs come from the useChat return below, so thread them
  // through a ref.
  const addToolOutputRef = useRef<ReturnType<typeof useChat>['addToolOutput'] | null>(null);

  const { messages, sendMessage, stop, status, error, addToolOutput, addToolApprovalResponse } = useChat({
    id: chatId,
    transport: chatTransport,
    messages: initialMessages,
    // Rejoin an in-flight run's stream after a reload: the adapter classifies
    // the open run from channel history and replays it.
    resume: true,
    // Auto-submit a continuation once a client-side tool result or a
    // server-tool approval resolves. The resolution carries no run id, so it
    // wakes a fresh run (on a fresh workflow).
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages: msgs }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
    onToolCall: ({ toolCall }) => {
      setCallbackLog((prev) => [
        ...prev,
        { time: Date.now(), type: 'onToolCall', summary: `${toolCall.toolName}(${JSON.stringify(toolCall.input)})` },
      ]);
      // Client-executed tools (no server `execute`): run them in the browser
      // and feed the output back; sendAutomaticallyWhen then publishes the
      // resolution, which wakes the answering run.
      if (!hasClientTool(toolCall.toolName)) return;
      void runClientTool(toolCall.toolName, toolCall.toolCallId, toolCall.input, recordClientTool).then((result) => {
        const add = addToolOutputRef.current;
        if (!add) return;
        if ('output' in result) {
          void add({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output: result.output });
        } else {
          void add({
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
    onError: (err) => {
      setCallbackLog((prev) => [...prev, { time: Date.now(), type: 'onError', summary: err.message }]);
    },
  });

  useEffect(() => {
    addToolOutputRef.current = addToolOutput;
  }, [addToolOutput]);

  // Track status transitions, annotating an `error` transition with the
  // accompanying error message useChat exposes alongside the status.
  useEffect(() => {
    setStatusLog((prev) => [
      ...prev,
      { time: Date.now(), status, error: status === 'error' ? error?.message : undefined },
    ]);
  }, [status, error]);

  const isRunning = status === 'submitted' || status === 'streaming';

  const cancelRun = useCallback(async () => stopAndCancel(stop, chatTransport), [stop, chatTransport]);

  const ablyMessages = useAblyMessages();

  // Armed fault for the next turn. It rides a one-shot cookie the chat route
  // consumes (the AIT transport owns the POST body, so demo controls travel
  // out-of-band); the route clears the cookie with the send that carried it.
  const [fault, setFault] = useState<FaultMode | undefined>(undefined);
  const armFault = useCallback((next: FaultMode | undefined) => {
    setFault(next);
    document.cookie = next ? `${FAULT_COOKIE}=${next}; path=/` : `${FAULT_COOKIE}=; path=/; max-age=0`;
  }, []);

  // The route consumes the armed fault with the send that carries it; disarm
  // the toggle visually to match.
  useEffect(() => {
    if (status === 'submitted') setFault(undefined);
  }, [status]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <div className="min-w-0 flex-1">
        <ChatContainer
          chatId={chatId}
          clientId={clientId}
          headerTitle="Ably AI Transport — Vercel WDK"
          scenarios={SCENARIOS}
          introTitle={INTRO_TITLE}
          introDescription={INTRO_DESCRIPTION}
          messages={messages}
          isRunning={isRunning}
          onSend={(text) => {
            void sendMessage({ text });
          }}
          onStop={() => void cancelRun()}
          onToolApprove={(toolPart) => {
            const id = toolPart.approval?.id;
            if (id) void addToolApprovalResponse({ id, approved: true });
          }}
          onToolDeny={(toolPart) => {
            const id = toolPart.approval?.id;
            if (id) void addToolApprovalResponse({ id, approved: false, reason: 'User denied' });
          }}
          ablyMessages={ablyMessages}
          callbackLog={callbackLog}
          clientToolLog={clientToolLog}
          statusLog={statusLog}
          onClearLogs={clearLogs}
          extraSlot={
            <FaultControls
              fault={fault}
              onChange={armFault}
            />
          }
        />
      </div>
      {/* The shared Chat owns its debug pane; the WDK process view renders as
          a sibling column so both panels stay visible. */}
      <WdkProcessPanel channelName={chatId} />
    </div>
  );
}
