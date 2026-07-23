'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientRun } from '@ably/ai-transport';
import type { OpenAIInput, OpenAIMessage } from '@ably/ai-transport/openai';
import { ResponsesCodec } from '@ably/ai-transport/openai';

import { userTurn, wakeAgent } from '../helpers';
import { MessageList } from './message-list';
import type { CallbackLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import { SuggestionChips } from './suggestion-chips';
import { useDemoProgress } from '../hooks/use-demo-progress';
import { SessionHooks } from '../providers';
import { clientColor } from '../lib/client-color';
import { AvatarStack } from './avatar-stack';

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

  // Derive which intro-card steps are still unfinished from the tree, so the
  // suggestion chips stay in sync across clients via channel history.
  const unfinishedSteps = useDemoProgress(messages, branchSelection, runOf, ablyMessages);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header
          clientId={clientId}
          channelName={chatId}
        />
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
        />
        <div className="border-t border-zinc-800">
          <SuggestionChips
            steps={unfinishedSteps}
            onSelectPrompt={handleSelectPrompt}
          />
          <InputBar
            value={input}
            onChange={setInput}
            inputRef={inputRef}
            onSend={(text) => wake(view.send(ResponsesCodec.createUserMessage(userTurn(text))))}
            onStop={() => {
              if (!latestRunId) return;
              // Stop only shows for an ACTIVE run, so a live agent is attached:
              // publishing the cancel signal makes it abort and publish run-end,
              // which flips the run to a terminal status and reverts Stop to Send.
              void session.cancel(latestRunId);
            }}
            hasAnyRuns={isRunInProgress}
          />
        </div>
      </div>
      <DebugPane
        messages={messages}
        ablyMessages={ablyMessages}
        status={status}
        callbackLog={callbackLog}
        statusLog={statusLog}
        onClearLogs={clearLogs}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ clientId, channelName }: { clientId?: string; channelName: string }) {
  return (
    <header className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <h1 className="text-sm font-medium text-zinc-300">Ably AI — OpenAI Responses</h1>
        </div>
        <div className="flex items-center gap-2 pl-4">
          <a
            href="https://github.com/ably/ably-ai-transport-js"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition-colors"
          >
            SDK repo
            <ExternalLinkIcon />
          </a>
          <a
            href="https://ably.com/docs/ai-transport"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition-colors"
          >
            Ably docs
            <ExternalLinkIcon />
          </a>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <AvatarStack
          channelName={channelName}
          selfClientId={clientId}
        />
        <button
          type="button"
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.delete('clientId');
            window.open(url.toString(), '_blank');
          }}
          className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          title="Open this channel in a new tab as a fresh client"
        >
          open in new tab
        </button>
        {clientId && <span className={`font-mono text-xs ${clientColor(clientId).text}`}>{clientId}</span>}
      </div>
    </header>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.75}
      stroke="currentColor"
      className="h-3 w-3"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Input bar — single Stop button when streaming, Send button otherwise
// ---------------------------------------------------------------------------

function InputBar({
  value,
  onChange,
  inputRef,
  onSend,
  onStop,
  hasAnyRuns,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onSend: (text: string) => void;
  onStop: () => void;
  hasAnyRuns: boolean;
}) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text) return;
    onChange('');
    onSend(text);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="px-4 py-3 flex gap-2"
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type a message..."
        className="flex-1 rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
        autoFocus
      />
      {hasAnyRuns ? (
        <button
          type="button"
          onClick={onStop}
          className="rounded-md bg-red-900/60 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/80 transition-colors"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={!value.trim()}
          className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      )}
    </form>
  );
}
