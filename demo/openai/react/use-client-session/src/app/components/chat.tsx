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
import { useClientTools } from '../hooks/use-client-tools';
import { useToolResolution } from '../hooks/use-tool-resolution';
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

  // Log a client-tool execution into the callback log so the demo shows which
  // client ran the browser tool.
  const logClientTool = useCallback((summary: string) => {
    setCallbackLog((prev) => [...prev, { time: Date.now(), type: 'clientTool', summary }]);
  }, []);

  const reportError = useCallback((error: unknown) => {
    setCallbackLog((prev) => [
      ...prev,
      {
        time: Date.now(),
        type: 'error',
        summary: error instanceof Error ? error.message : 'failed to wake agent',
      },
    ]);
  }, []);

  // Wake the agent for a run by POSTing its invocation pointer. The core session
  // never sends HTTP — the app owns the trigger.
  const wakeRun = useCallback(
    (run: ClientRun<OpenAIInput, OpenAIMessage>) => {
      void wakeAgent(api, run).catch(reportError);
    },
    [api, reportError],
  );

  // The same wake for send sites, which hold the `view.send*` promise rather
  // than the run. A publish or POST failure is surfaced in the log.
  const wake = useCallback(
    (runPromise: Promise<ClientRun<OpenAIInput, OpenAIMessage>>) => {
      void runPromise.then(wakeRun).catch(reportError);
    },
    [wakeRun, reportError],
  );

  // Publish a tool resolution, waking the agent only once every call on the run
  // has an answer — a turn that gated two calls must not resume after the first.
  const resolveToolCall = useToolResolution({ view, onWake: wakeRun });

  // Run client-executed tools (getLocation) when they appear unresolved and
  // publish the result through the same gate.
  useClientTools(view, clientId, resolveToolCall, logClientTool);

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

  // Approve / deny a gated tool call. The resolution publishes immediately; the
  // agent is only woken once every call on the run has an answer, so a turn that
  // gated two calls resumes after the second decision rather than the first.
  const handleToolApprove = useCallback(
    (codecMessageId: string, callId: string) => {
      void resolveToolCall({
        codecMessageId,
        callId,
        input: ResponsesCodec.createToolApprovalResponse(codecMessageId, { call_id: callId, approved: true }),
      });
    },
    [resolveToolCall],
  );

  const handleToolDeny = useCallback(
    (codecMessageId: string, callId: string) => {
      void resolveToolCall({
        codecMessageId,
        callId,
        input: ResponsesCodec.createToolApprovalResponse(codecMessageId, {
          call_id: callId,
          approved: false,
          reason: 'User denied',
        }),
      });
    },
    [resolveToolCall],
  );

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
          onApproveTool={handleToolApprove}
          onDenyTool={handleToolDeny}
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
