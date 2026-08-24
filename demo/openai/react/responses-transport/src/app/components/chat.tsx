'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAblyMessages, useClientTransport, useTransportEvents } from '@ably/ai-transport/react';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import type { OpenAIInput } from '../lib/openai-thread';
import { ChatShell } from '@ably-ai-demos/frontend/components/chat-shell';

import { userTurn, wakeAgent } from '../helpers';
import { MessageList } from './message-list';
import type { CallbackLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import { useDemoProgress } from '../hooks/use-demo-progress';
import { useClientTools } from '../hooks/use-client-tools';
import { useResponsesThread } from '../hooks/use-responses-thread';
import { useToolResolution } from '../hooks/use-tool-resolution';
import { DEMO_SCENARIOS } from '../lib/intro-content';

interface ChatProps {
  chatId: string;
  clientId?: string;
  /** Agent endpoint the demo POSTs wake pointers to, to wake the serverless agent. */
  api: string;
}

export function Chat({ chatId, clientId, api }: ChatProps) {
  const { transport, error: transportError } = useClientTransport<OpenAIInput, OpenAIOutput>();

  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
  }, []);

  const log = useCallback((type: CallbackLogEntry['type'], summary: string) => {
    setCallbackLog((prev) => [...prev, { time: Date.now(), type, summary }]);
  }, []);

  const reportError = useCallback(
    (error: unknown) => {
      log('error', error instanceof Error ? error.message : String(error));
    },
    [log],
  );

  // The demo's conversation state: hydrated from the messages endpoint plus a
  // gap walk to the live attach point, then live transport events, all merged
  // through OpenAI's own accumulator.
  const { messages, runs, isRunning, activeRunId, hydrated } = useResponsesThread({
    channelName: chatId,
    onMergeError: reportError,
  });

  // Log a client-tool execution into the callback log so the demo shows which
  // client ran the browser tool.
  const logClientTool = useCallback(
    (summary: string) => {
      log('clientTool', summary);
    },
    [log],
  );

  // Wake the agent by POSTing the published input's pointer. The client
  // transport never sends HTTP — the app owns the trigger.
  const wake = useCallback(
    (eventId: string) => {
      void wakeAgent(api, { channelName: chatId, eventId }).catch(reportError);
    },
    [api, chatId, reportError],
  );

  // Publish a tool resolution, waking the agent only once every call on the run
  // has an answer — a turn that gated two calls must not resume after the first.
  const resolveToolCall = useToolResolution({
    transport,
    messages,
    onWake: ({ eventId }) => {
      wake(eventId);
    },
  });

  // Run client-executed tools (getLocation) when they appear unresolved and
  // publish the result through the same gate.
  useClientTools(messages, runs, clientId, resolveToolCall, logClientTool);

  const status = isRunning ? 'running' : 'idle';
  useEffect(() => {
    setStatusLog((prev) => [...prev, { time: Date.now(), status }]);
  }, [status]);

  // Surface run lifecycle events and transport errors in the debug pane's log.
  useTransportEvents<OpenAIInput, OpenAIOutput>((event) => {
    if (event.kind !== 'run-lifecycle') return;
    const lifecycle = event.event;
    const head = `runId=${lifecycle.runId.slice(0, 8)}`;
    if (lifecycle.type === 'start') log('runStart', head);
    else if (lifecycle.type === 'suspend') log('runSuspend', head);
    else if (lifecycle.type === 'resume') log('runResume', head);
    else log('runEnd', `${head}, reason=${lifecycle.reason}`);
  });

  useEffect(() => {
    if (transportError) reportError(transportError);
    if (!transport) return;
    return transport.on('error', (error) => {
      reportError(error);
    });
  }, [transport, transportError, reportError]);

  const ablyMessages = useAblyMessages();

  // Derive which scenarios are still unfinished from the thread, so the
  // suggestion chips stay in sync across clients via channel history.
  const unfinishedScenarios = useDemoProgress(DEMO_SCENARIOS, messages, ablyMessages);

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
  const decideToolCall = useCallback(
    (codecMessageId: string, callId: string, approved: boolean) => {
      const runId = messages.find((message) => message.codecMessageId === codecMessageId)?.runId;
      if (runId === undefined) return;
      const inputs: OpenAIInput[] = approved
        ? [{ kind: 'approval', payload: { call_id: callId, approved: true } }]
        : [
            { kind: 'approval', payload: { call_id: callId, approved: false, reason: 'User denied' } },
            // A denial still owes the model an output for the call, so the
            // client authors the rejection — the /responses round-trip then has
            // no dangling function_call.
            {
              kind: 'item',
              payload: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({ error: 'The user denied this tool execution.' }),
              },
            },
          ];
      void resolveToolCall({ codecMessageId, runId, callId, inputs }).catch(reportError);
    },
    [messages, resolveToolCall, reportError],
  );

  return (
    <ChatShell
      title="Ably AI — OpenAI Responses"
      channelName={chatId}
      clientId={clientId}
      transcript={
        <MessageList
          messages={messages}
          runs={runs}
          loading={!hydrated}
          scrollToEndRef={scrollToEndRef}
          onApproveTool={(codecMessageId, callId) => {
            decideToolCall(codecMessageId, callId, true);
          }}
          onDenyTool={(codecMessageId, callId) => {
            decideToolCall(codecMessageId, callId, false);
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
          onClearLogs={clearLogs}
        />
      }
      suggestions={unfinishedScenarios}
      onSelectPrompt={handleSelectPrompt}
      input={input}
      onInputChange={setInput}
      inputRef={inputRef}
      onSend={(text) => {
        if (!transport) return;
        // Publish first, wake second: the agent reads the conversation off the
        // channel, so the input has to be there before the POST lands.
        void transport
          .publishInput({ kind: 'message', payload: userTurn(text) })
          .then(({ eventId }) => {
            wake(eventId);
          })
          .catch(reportError);
        scrollToEndRef.current?.();
      }}
      onStop={() => {
        if (!transport || activeRunId === undefined) return;
        // Stop only shows for an ACTIVE run, so a live agent is attached:
        // publishing the cancel signal makes it abort and publish run-end,
        // which flips the run to a terminal status and reverts Stop to Send.
        void transport.cancel(activeRunId).catch(reportError);
      }}
      isRunning={isRunning}
    />
  );
}
