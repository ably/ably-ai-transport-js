'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientRun, RunInfo, RunStatus } from '@ably/ai-transport';
import type { UIMessage, DynamicToolUIPart } from 'ai';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { useMessagesWithSeed } from '@ably/ai-transport/vercel/react';

import { userMessage, wakeAgent } from '../helpers';
import { useClientTools } from '../hooks/use-client-tools';
import { useDemoProgress } from '../hooks/use-demo-progress';
import { MessageList, type BubbleStatus } from './message-list';
import { SuggestionChips } from './suggestion-chips';
import type { CallbackLogEntry, ClientToolLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import { SessionHooks } from '../providers';
import { clientColor } from '../lib/client-color';
import { AvatarStack } from './avatar-stack';

const { useClientSession, useAblyMessages } = SessionHooks;

/** Props for {@link Chat}. */
interface ChatProps {
  /** The conversation id (the channel name) — rendered in the header. */
  chatId: string;
  /** This client's own clientId, for attribution and the avatar stack. */
  clientId?: string;
  /** The persisted conversation loaded from the database, used to seed the view. */
  seed: UIMessage[];
  /** Agent endpoint the demo POSTs invocations to, to wake the serverless agent. */
  api: string;
}

// Translate a run's literal lifecycle status to the bubble's rendering
// vocabulary (`'active'` → `'streaming'`).
function bubbleStatus(status: RunStatus | undefined): BubbleStatus | undefined {
  if (status === 'active') return 'streaming';
  return status;
}

/**
 * The database-hydration demo's chat. It renders the same rich UI as the
 * sibling `use-client-session` demo (tools, client-tool execution, the approval
 * flow, the debug pane, suggestion chips, the avatar stack) but is deliberately
 * **linear** — no branch navigation, no edit, no regenerate.
 *
 * Its rendering source is the database seed reconciled with the live channel
 * via `useMessagesWithSeed` (the SDK seam walk), not paginated/branching
 * `useView`. It still holds `session.view` for the codec-message-id-keyed
 * operations the tool flows need (client-tool gating, approval targeting) and
 * for run-state tracking.
 * @param props - The conversation id, this client's id, the database seed, and the agent endpoint.
 */
export function Chat({ chatId, clientId, seed, api }: ChatProps) {
  const { session } = useClientSession();
  const view = session.view;

  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
  const [clientToolLog, setClientToolLog] = useState<ClientToolLogEntry[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
    setClientToolLog([]);
  }, []);

  // Record client-side tool executions, keyed by toolCallId. Each onExecute
  // call carries a complete entry, so the `done`/`error` entry replaces the
  // earlier `executing` one in place.
  const recordClientTool = useCallback((entry: ClientToolLogEntry) => {
    setClientToolLog((prev) => {
      const idx = prev.findIndex((e) => e.toolCallId === entry.toolCallId);
      if (idx === -1) return [...prev, entry];
      const next = [...prev];
      next[idx] = entry;
      return next;
    });
  }, []);

  // The rendered conversation: the database seed reconciled with the live
  // channel at the seam. Linear UIMessage[] — no codec-message-ids.
  const messages = useMessagesWithSeed({ view, seed });

  // The client-tool driver reads view.getMessages() directly (which carry
  // codec-message-ids), independent of the linear list we render.
  useClientTools(view, clientId, api, recordClientTool);

  // Wake the agent for a freshly-sent run by POSTing its invocation pointer.
  // The core session never sends HTTP — the app owns the trigger. Send sites
  // pass the `view.send*` promise; a POST failure is surfaced in the log.
  const wake = useCallback(
    (runPromise: Promise<ClientRun<UIMessage>>) => {
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

  // Track the latest run so the last assistant response can show its live state
  // (streaming → complete) and the composer can offer Stop while it streams.
  // The status transitions (run-start → run-end) arrive on the view's 'run'
  // event, not 'update' (which carries streamed content) — subscribe to both so
  // the response settles out of 'streaming' when the run ends.
  const [latestRun, setLatestRun] = useState<{ runId: string; status: RunStatus } | undefined>();
  useEffect(() => {
    const sync = (): void => {
      const run = view.runs().at(-1);
      setLatestRun(run ? { runId: run.runId, status: run.status } : undefined);
    };
    sync();
    const offUpdate = view.on('update', sync);
    const offRun = view.on('run', sync);
    return () => {
      offUpdate();
      offRun();
    };
  }, [view]);

  // Stop is shown ONLY while the latest run is actively streaming ('active').
  // A 'suspended' run is paused awaiting input - a client tool result, or a
  // tool-approval decision - so there is no live stream to abort: the user
  // proceeds via the approval card, and the bar shows Send. Terminal statuses
  // also show Send. The runId is what Stop needs to cancel.
  const isRunInProgress = latestRun !== undefined && latestRun.status === 'active';
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

  // The debug pane renders CodecMessage pairs; pair the linear list up with
  // each message's own domain id (this demo has no separate codec id to show).
  const codecMessages = useMemo(() => messages.map((message) => ({ codecMessageId: message.id, message })), [messages]);

  // Snapshot the visible runs for demo-progress derivation. `latestRun` is a
  // recompute trigger, not a value read here: it changes as runs start/end, so
  // depending on it re-reads view.runs() when the run set changes.
  const runs = useMemo<RunInfo[]>(() => view.runs(), [view, latestRun]);
  const unfinishedSteps = useDemoProgress(messages, runs);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  // The rendered list is linear UIMessage[] with no codec-message-id, but tool
  // approve/deny must address the owning assistant's codec-message-id. Look it
  // up from view.getMessages() by finding the entry whose message contains the
  // tool call, then send the approval on the channel keyed on that id + runId.
  const codecMessageIdForToolCall = useCallback(
    (toolCallId: string): string | undefined => {
      for (const { codecMessageId, message } of view.getMessages()) {
        for (const part of message.parts) {
          if (part.type !== 'dynamic-tool') continue;
          if ((part as DynamicToolUIPart).toolCallId === toolCallId) return codecMessageId;
        }
      }
      return undefined;
    },
    [view],
  );

  const handleToolApprove = useCallback(
    (toolCallId: string) => {
      const codecMessageId = codecMessageIdForToolCall(toolCallId);
      if (!codecMessageId) return;
      const run = view.runOf(codecMessageId);
      if (!run) return;
      wake(
        view.send([UIMessageCodec.createToolApprovalResponse(codecMessageId, { toolCallId, approved: true })], {
          runId: run.runId,
        }),
      );
    },
    [view, wake, codecMessageIdForToolCall],
  );

  const handleToolDeny = useCallback(
    (toolCallId: string) => {
      const codecMessageId = codecMessageIdForToolCall(toolCallId);
      if (!codecMessageId) return;
      const run = view.runOf(codecMessageId);
      if (!run) return;
      wake(
        view.send(
          [
            UIMessageCodec.createToolApprovalResponse(codecMessageId, {
              toolCallId,
              approved: false,
              reason: 'User denied',
            }),
          ],
          { runId: run.runId },
        ),
      );
    },
    [view, wake, codecMessageIdForToolCall],
  );

  // The last assistant message reflects the latest run's live state; earlier
  // assistant messages are from terminal runs and are complete.
  const statusOf = useCallback(
    (message: UIMessage, index: number): BubbleStatus | undefined => {
      if (message.role !== 'assistant') return undefined;
      if (index === messages.length - 1) return bubbleStatus(latestRun?.status) ?? 'complete';
      return 'complete';
    },
    [messages.length, latestRun],
  );

  const handleSend = useCallback(
    (text: string) => {
      // Linear history: cancel any still-active response before starting a new
      // run, so the seam reconciliation only ever meets complete (or cancelled)
      // runs. Then send over the session view and wake the agent.
      void (async () => {
        try {
          if (latestRun?.status === 'active') await session.cancel(latestRun.runId);
        } catch {
          // best-effort cancel; the send below still proceeds
        }
        wake(view.send(UIMessageCodec.createUserMessage(userMessage(text))));
      })();
    },
    [latestRun, session, view, wake],
  );

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header
          clientId={clientId}
          channelName={chatId}
        />
        <MessageList
          messages={messages}
          statusOf={statusOf}
          onToolApprove={handleToolApprove}
          onToolDeny={handleToolDeny}
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
            onSend={handleSend}
            onStop={() => {
              if (!latestRun) return;
              // Stop only shows for an ACTIVE run, so a live agent is attached:
              // publishing the cancel signal makes it abort and publish run-end,
              // which flips the run to a terminal status and reverts Stop to Send.
              void session.cancel(latestRun.runId);
            }}
            streaming={isRunInProgress}
          />
        </div>
      </div>
      <DebugPane
        messages={codecMessages}
        ablyMessages={ablyMessages}
        status={status}
        callbackLog={callbackLog}
        statusLog={statusLog}
        clientToolLog={clientToolLog}
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
          <h1 className="text-sm font-medium text-zinc-300">Ably AI — ClientSession (DB hydration)</h1>
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
  streaming,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
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
      {streaming ? (
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
