'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClientRun } from '@ably/ai-transport';
import type { UIMessage } from 'ai';
import { UIMessageCodec, type VercelInput } from '@ably/ai-transport/vercel';

import { userMessage, wakeAgent } from '../helpers';
import { useClientTools } from '../hooks/use-client-tools';
import { useDemoProgress, type DemoStep as ProgressStep } from '../hooks/use-demo-progress';
import { MessageList } from './message-list';
import { SuggestionChips } from './suggestion-chips';
import type { ClientToolLogEntry, LifecycleLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import type { DemoStep } from './intro-card';
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
  /**
   * Optional slot rendered between the message list and the input bar — the
   * anchor for a demo-specific widget (e.g. the LiveObjects checklist widget
   * in the use-client-session demo). Left undefined by default so demos that
   * don't need one contribute nothing to the DOM.
   */
  extraSlot?: ReactNode;
  /**
   * Custom scenarios for the intro card when the conversation is empty.
   * Forwarded to {@link MessageList}. Defaults to the shared baseline list.
   */
  demoSteps?: readonly DemoStep[];
  /** Heading for the intro card. Defaults to the generic ClientSession heading. */
  demoTitle?: string;
  /** Intro blurb for the intro card. Defaults to the generic ClientSession blurb. */
  demoDescription?: string;
  /**
   * Extra suggestion-chip scenarios this demo's model supports, appended to the
   * shared baseline. Use for prompts a generic weather model can't drive (e.g.
   * the stock retry), so they only appear in demos that opt in.
   */
  extraProgressSteps?: readonly ProgressStep[];
}

export function Chat({
  chatId,
  clientId,
  historyLimit,
  api,
  extraSlot,
  demoSteps,
  demoTitle,
  demoDescription,
  extraProgressSteps,
}: ChatProps) {
  const { session } = useClientSession();

  const [lifecycleLog, setLifecycleLog] = useState<LifecycleLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
  const [clientToolLog, setClientToolLog] = useState<ClientToolLogEntry[]>([]);
  const clearLogs = useCallback(() => {
    setLifecycleLog([]);
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

  const view = useView({ limit: historyLimit ?? 30 });
  const { messages, hasOlder, loading, loadOlder, branchSelection, runOf } = view;

  useClientTools(view, clientId, api, recordClientTool);

  // Track active ClientRun handles by their resolved run-id so /steer can
  // target the live one. Cleaned up on run-end via the tree.on('run') hook
  // below. A ref instead of state — only the steer call site reads it, and
  // re-rendering is unnecessary.
  const activeRunsRef = useRef<Map<string, ClientRun<VercelInput, UIMessage>>>(new Map());

  // Wake the agent for a freshly-sent run by POSTing its invocation pointer.
  // The core session never sends HTTP — the app owns the trigger. Send sites
  // pass the `view.send*` promise; a POST failure is surfaced in the log.
  const wake = useCallback(
    (runPromise: Promise<ClientRun<VercelInput, UIMessage>>) => {
      void runPromise
        .then(async (run) => {
          // Register the handle for /steer once the agent has minted the
          // run-id. The dead-handle path on the SDK rejects steer() calls
          // after run-end, so leaving stale entries here is safe — we still
          // clean up on run-end below to keep the map bounded.
          run.started
            .then(() => {
              activeRunsRef.current.set(run.runId, run);
            })
            .catch(() => {
              // runId never resolved — nothing to register. The wake POST
              // below will surface any underlying error.
            });
          await wakeAgent(api, run);
        })
        .catch((error: unknown) => {
          setLifecycleLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'error',
              detail: error instanceof Error ? error.message : 'failed to wake agent',
            },
          ]);
        });
    },
    [api],
  );

  // Steer the active Run with a follow-up user message. Looks up the latest
  // active run by walking the View's run list newest-first; the handle's
  // .steer() returns { published, outcome } which we log so the demo
  // visualises consumed / not-consumed at run-end.
  const steerActiveRun = useCallback(
    (text: string) => {
      const runs = view.runs();
      const active = [...runs].reverse().find((r) => r.status === 'active' || r.status === 'suspended');
      if (!active) {
        setLifecycleLog((prev) => [
          ...prev,
          {
            time: Date.now(),
            type: 'steerRejected',
            detail: 'no active run to steer — send a message first',
          },
        ]);
        return;
      }
      const handle = activeRunsRef.current.get(active.runId);
      if (!handle) {
        setLifecycleLog((prev) => [
          ...prev,
          {
            time: Date.now(),
            type: 'steerRejected',
            detail: `active run ${active.runId.slice(0, 8)} has no local handle (opened elsewhere)`,
          },
        ]);
        return;
      }
      const head = `runId=${active.runId.slice(0, 8)}`;
      const { published, outcome } = handle.steer(UIMessageCodec.createUserMessage(userMessage(text)));
      void published
        .then(({ serial }) => {
          setLifecycleLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'steerPublished',
              detail: `${head}, serial=${serial ?? '?'}`,
            },
          ]);
        })
        .catch((error: unknown) => {
          setLifecycleLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'steerRejected',
              detail: error instanceof Error ? error.message : 'steer rejected',
            },
          ]);
        });
      void outcome
        .then(({ consumed, runTerminalReason }) => {
          setLifecycleLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'steerOutcome',
              detail: `${head}, ${consumed ? 'consumed' : 'not-consumed'}${runTerminalReason ? ` (${runTerminalReason})` : ''}`,
            },
          ]);
        })
        .catch((error: unknown) => {
          setLifecycleLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'steerRejected',
              detail: error instanceof Error ? error.message : 'steer outcome rejected',
            },
          ]);
        });
    },
    [view],
  );

  // Derive "is a run in progress?" from the latest visible message's owning
  // Run status. Stop is shown ONLY while the run is actively streaming
  // ('active'). A 'suspended' run is paused awaiting input - a client tool
  // result, or a tool-approval decision - so there is no live stream to abort:
  // the user proceeds via the approval card, and the bar shows Send. This
  // mirrors the useChat demo, where Stop shows only for status
  // 'submitted' | 'streaming'. Terminal statuses ('complete' | 'cancelled' |
  // 'error') also show Send. The Run carries the runId Stop needs to cancel.
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
      const detail = `run: ${event.runId.slice(0, 8)}, client: ${event.clientId}`;
      let type: LifecycleLogEntry['type'];
      let reason: string | undefined;
      if (event.type === 'start') {
        type = 'runStart';
      } else if (event.type === 'suspend') {
        type = 'runSuspend';
      } else if (event.type === 'resume') {
        type = 'runResume';
      } else {
        type = 'runEnd';
        reason = event.reason;
        // Drop the local handle — the SDK marks it dead and rejects further
        // steer() calls synchronously, so the entry would just sit here.
        activeRunsRef.current.delete(event.runId);
      }
      setLifecycleLog((prev) => [...prev, { time: event.timestamp ?? Date.now(), type, detail, reason }]);
    });
    const offStep = session.tree.on('step', (event) => {
      const detail = `run: ${event.runId.slice(0, 8)}, step: ${event.stepId.slice(0, 8)}${
        event.stepClientId ? `, client: ${event.stepClientId}` : ''
      }`;
      const entry: LifecycleLogEntry =
        event.type === 'step-start'
          ? { time: event.timestamp ?? Date.now(), type: 'stepStart', detail }
          : { time: event.timestamp ?? Date.now(), type: 'stepEnd', detail, reason: event.reason };
      setLifecycleLog((prev) => [...prev, entry]);
    });
    const offErr = session.on('error', (error) => {
      setLifecycleLog((prev) => [...prev, { time: Date.now(), type: 'error', detail: error.message }]);
    });
    return () => {
      offRun();
      offStep();
      offErr();
    };
  }, [session]);

  const ablyMessages = useAblyMessages();

  const unfinishedSteps = useDemoProgress(messages, branchSelection, runOf, ablyMessages, extraProgressSteps);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  const handleToolApprove = useCallback(
    (codecMessageId: string, toolCallId: string) => {
      const run = view.runOf(codecMessageId);
      if (!run) return;
      wake(
        view.send([UIMessageCodec.createToolApprovalResponse(codecMessageId, { toolCallId, approved: true })], {
          runId: run.runId,
        }),
      );
    },
    [view, wake],
  );

  const handleToolDeny = useCallback(
    (codecMessageId: string, toolCallId: string) => {
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
    [view, wake],
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
          hasOlder={hasOlder}
          loading={loading}
          view={{
            branchSelection,
            runOf,
          }}
          onLoadOlder={() => void loadOlder()}
          onRegenerate={(codecMessageId) => wake(view.regenerate(codecMessageId))}
          onEdit={(codecMessageId, text) =>
            wake(view.edit(codecMessageId, [UIMessageCodec.createUserMessage(userMessage(text))]))
          }
          onToolApprove={handleToolApprove}
          onToolDeny={handleToolDeny}
          demoSteps={demoSteps}
          demoTitle={demoTitle}
          demoDescription={demoDescription}
        />
        {extraSlot}
        <div className="border-t border-zinc-800">
          <SuggestionChips
            steps={unfinishedSteps}
            onSelectPrompt={handleSelectPrompt}
          />
          <InputBar
            value={input}
            onChange={setInput}
            inputRef={inputRef}
            onSend={(text) => {
              // `/steer <text>` targets the latest active Run via
              // activeRun.steer(...) — a follow-up user message inside the
              // running Run rather than a fresh send. The agent's
              // run.hasInput() loop picks it up at the next iteration.
              const steerMatch = /^\/steer\s+(.+)$/.exec(text);
              if (steerMatch) {
                steerActiveRun(steerMatch[1]?.trim() ?? '');
                return;
              }
              wake(view.send(UIMessageCodec.createUserMessage(userMessage(text))));
            }}
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
        lifecycleLog={lifecycleLog}
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
          <h1 className="text-sm font-medium text-zinc-300">Ably AI — ClientSession</h1>
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
        placeholder="Type a message... — or /steer <text> to steer the active run"
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
