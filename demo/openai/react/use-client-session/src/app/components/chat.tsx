'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientRun } from '@ably/ai-transport';
import type { OpenAIInput, OpenAIMessage } from '@ably/ai-transport/openai';
import { ResponsesCodec } from '@ably/ai-transport/openai';
import { ChatShell } from '@ably-ai-demos/frontend/components/chat-shell';

import { userTurn, wakeAgent } from '../helpers';
import { MessageList } from './message-list';
import type { CallbackLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import { useDemoProgress } from '../hooks/use-demo-progress';
import { DEMO_SCENARIOS } from '../lib/intro-content';
import { SessionHooks } from '../providers';

const { useClientSession, useView, useAblyMessages } = SessionHooks;

interface ChatProps {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
  /** Agent endpoint the demo POSTs invocations to, to wake the serverless agent. */
  api: string;
}

export function Chat({ chatId, clientId, historyLimit, api }: ChatProps) {
  const { session } = useClientSession();

  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
  }, []);

  const view = useView({ limit: historyLimit ?? 30 });
  const { messages, hasOlder, loading, loadOlder, branchSelection, runOf } = view;

  // Wake the agent for a freshly-sent run by POSTing its invocation pointer.
  // The core session never sends HTTP — the app owns the trigger. Send sites
  // pass the `view.send*` promise; a POST failure is surfaced in the log.
  const wake = useCallback(
    (runPromise: Promise<ClientRun<OpenAIInput, OpenAIMessage>>) => {
      void runPromise
        .then((run) => wakeAgent(api, run))
        .catch((error: unknown) => {
          setCallbackLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'error',
              summary: error instanceof Error ? error.message : 'failed to wake agent',
            },
          ]);
        });
    },
    [api],
  );

  // Derive "is a run in progress?" from the latest visible message's owning
  // Run status. Stop is shown ONLY while the run is actively streaming
  // ('active'). Terminal statuses ('complete' | 'cancelled' | 'error') show
  // Send. The Run carries the runId Stop needs to cancel.
  const latestRun = runOf(messages.at(-1)?.codecMessageId ?? '');
  const latestRunId = latestRun?.runId;
  const latestStatus = latestRun?.status;
  const isRunInProgress = latestRunId !== undefined && latestStatus === 'active';
  const status = isRunInProgress ? 'running' : 'idle';

  useEffect(() => {
    setStatusLog((prev) => [...prev, { time: Date.now(), status }]);
  }, [status]);

  useEffect(() => {
    const offRun = session.tree.on('run', (event) => {
      const head = `runId=${event.runId.slice(0, 8)}, clientId=${event.clientId}`;
      let type: CallbackLogEntry['type'];
      let summary: string;
      if (event.type === 'start') {
        type = 'runStart';
        summary = head;
      } else if (event.type === 'suspend') {
        type = 'runSuspend';
        summary = head;
      } else if (event.type === 'resume') {
        type = 'runResume';
        summary = head;
      } else {
        type = 'runEnd';
        summary = `${head}, reason=${event.reason}`;
      }
      setCallbackLog((prev) => [
        ...prev,
        {
          time: Date.now(),
          type,
          summary,
        },
      ]);
    });
    const offErr = session.on('error', (error) => {
      setCallbackLog((prev) => [...prev, { time: Date.now(), type: 'error', summary: error.message }]);
    });
    return () => {
      offRun();
      offErr();
    };
  }, [session]);

  const ablyMessages = useAblyMessages();

  // Derive which scenarios are still unfinished from the tree, so the
  // suggestion chips stay in sync across clients via channel history.
  const unfinishedScenarios = useDemoProgress(DEMO_SCENARIOS, messages, branchSelection, runOf, ablyMessages);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollToEndRef = useRef<(() => void) | null>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  return (
    <ChatShell
      title="Ably AI — OpenAI Responses"
      channelName={chatId}
      clientId={clientId}
      transcript={
        <MessageList
          messages={messages}
          hasOlder={hasOlder}
          loading={loading}
          view={{
            branchSelection,
            runOf,
          }}
          onLoadOlder={() => void loadOlder()}
          onRegenerate={(codecMessageId) => wake(view.regenerate(codecMessageId))}
          onEdit={(codecMessageId, text) =>
            wake(view.edit(codecMessageId, [ResponsesCodec.createUserMessage(userTurn(text))]))
          }
          scrollToEndRef={scrollToEndRef}
        />
      }
      debugPane={
        <DebugPane
          messages={messages}
          ablyMessages={ablyMessages}
          status={status}
          callbackLog={callbackLog}
          statusLog={statusLog}
          onClearLogs={clearLogs}
        />
      }
      suggestions={unfinishedScenarios}
      onSelectPrompt={handleSelectPrompt}
      input={input}
      onInputChange={setInput}
      inputRef={inputRef}
      onSend={(text) => {
        wake(view.send(ResponsesCodec.createUserMessage(userTurn(text))));
        scrollToEndRef.current?.();
      }}
      onStop={() => {
        if (!latestRunId) return;
        // Stop only shows for an ACTIVE run, so a live agent is attached:
        // publishing the cancel signal makes it abort and publish run-end,
        // which flips the run to a terminal status and reverts Stop to Send.
        void session.cancel(latestRunId);
      }}
      isRunning={isRunInProgress}
    />
  );
}
