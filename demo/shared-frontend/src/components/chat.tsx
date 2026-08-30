'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClientRun } from '@ably/ai-transport';
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';
import { createUIMessageSessionCodec, type VercelSessionInput } from '@ably/ai-transport/vercel';

import { userMessage, wakeAgent } from '../helpers';
import { useClientTools } from '../hooks/use-client-tools';
import { useDemoProgress } from '../hooks/use-demo-progress';
import type { Scenario } from '../lib/progress-steps';
import { BranchingMessageList } from './message-list';
import type { CallbackLogEntry, ClientToolLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import { COMMON_SCENARIOS } from './intro-card';
import { ChatShell, type HeaderLink } from './chat-shell';
import { SessionHooks } from '../providers';

const { useClientSession, useView, useAblyMessages, useTree } = SessionHooks;
const uiMessageCodec = createUIMessageSessionCodec();

interface ChatProps {
  /** Ably channel name this session is bound to. */
  chatId: string;
  /** This client's id (tinted in the header). */
  clientId?: string;
  /** Page size for the paginated view. */
  historyLimit?: number;
  /** Agent endpoint the demo POSTs invocations to, to wake the serverless agent. */
  api: string;
  /**
   * Optional slot rendered between the message list and the input bar — the
   * anchor for a demo-specific widget (e.g. the LiveObjects checklist widget in
   * the use-client-session demo).
   */
  extraSlot?: ReactNode;
  /**
   * The scenarios this demo demonstrates — the single source for the intro-card
   * walkthrough and the suggestion chips. Defaults to the shared baseline.
   */
  scenarios?: readonly Scenario[];
  /** Intro-card heading. Defaults to the generic ClientSession heading. */
  introTitle?: string;
  /** Intro-card blurb. Defaults to the generic ClientSession blurb. */
  introDescription?: string;
  /** Header heading. Defaults to "Ably AI — ClientSession". */
  headerTitle?: string;
  /** Header links. Defaults to the SDK repo + Ably docs. */
  headerLinks?: readonly HeaderLink[];
}

export function Chat({
  chatId,
  clientId,
  historyLimit,
  api,
  extraSlot,
  scenarios = COMMON_SCENARIOS,
  introTitle,
  introDescription,
  headerTitle = 'Ably AI — ClientSession',
  headerLinks,
}: ChatProps) {
  const { session } = useClientSession();

  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
  const [clientToolLog, setClientToolLog] = useState<ClientToolLogEntry[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
    setClientToolLog([]);
  }, []);

  // Record client-side tool executions, keyed by toolCallId. Each onExecute call
  // carries a complete entry, so the `done`/`error` entry replaces the earlier
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

  const view = useView({ limit: historyLimit ?? 30 });
  const { messages, hasOlder, loading, loadOlder, branchSelection, runOf } = view;

  // The client-tool fork resolves its parent + the suspended run's messages
  // authoritatively from the run node (not a positional guess), so thread the
  // tree's `getRunNode` in.
  const { getRunNode } = useTree();
  useClientTools(view, getRunNode, clientId, api, recordClientTool);

  // Track active ClientRun handles by their resolved run-id so /steer can target
  // the live one. Cleaned up on run-end via the tree.on('run') hook below. A ref
  // instead of state — only the steer call site reads it, and re-rendering on
  // registration is unnecessary.
  const activeRunsRef = useRef<Map<string, ClientRun<VercelSessionInput, UIMessage>>>(new Map());

  // Wake the agent for a freshly-sent run by POSTing its invocation pointer. The
  // core session never sends HTTP — the app owns the trigger. Send sites pass the
  // `view.send*` promise; a POST failure is surfaced in the log.
  const wake = useCallback(
    (runPromise: Promise<ClientRun<VercelSessionInput, UIMessage>>) => {
      void runPromise
        .then(async (run) => {
          // Register the handle for /steer once the agent has minted the run-id.
          // The dead-handle path on the SDK rejects steer() calls after run-end,
          // so leaving stale entries is safe — we still clean up on run-end below
          // to keep the map bounded.
          run.started
            .then(() => {
              activeRunsRef.current.set(run.runId, run);
            })
            .catch(() => {
              // runId never resolved — nothing to register. The wake POST below
              // surfaces any underlying error.
            });
          await wakeAgent(api, run);
        })
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

  // Steer the active Run with a follow-up user message. Looks up the latest
  // active run by walking the View's run list newest-first; the handle's
  // .steer() returns { published, outcome }, both logged so the demo visualises
  // consumed / not-consumed at run-end.
  const steerActiveRun = useCallback(
    (text: string) => {
      const runs = view.runs();
      const active = [...runs].reverse().find((r) => r.status === 'active' || r.status === 'suspended');
      if (!active) {
        setCallbackLog((prev) => [
          ...prev,
          { time: Date.now(), type: 'steerRejected', summary: 'no active run to steer — send a message first' },
        ]);
        return;
      }
      const handle = activeRunsRef.current.get(active.runId);
      if (!handle) {
        setCallbackLog((prev) => [
          ...prev,
          {
            time: Date.now(),
            type: 'steerRejected',
            summary: `active run ${active.runId.slice(0, 8)} has no local handle (opened elsewhere)`,
          },
        ]);
        return;
      }
      const head = `runId=${active.runId.slice(0, 8)}`;
      const { published, outcome } = handle.steer(uiMessageCodec.createUserMessage(userMessage(text)));
      void published
        .then(({ serial }) => {
          setCallbackLog((prev) => [
            ...prev,
            { time: Date.now(), type: 'steerPublished', summary: `${head}, serial=${serial ?? '?'}` },
          ]);
        })
        .catch((error: unknown) => {
          setCallbackLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'steerRejected',
              summary: error instanceof Error ? error.message : 'steer rejected',
            },
          ]);
        });
      void outcome
        .then(({ consumed, runTerminalReason }) => {
          setCallbackLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'steerOutcome',
              summary: `${head}, ${consumed ? 'consumed' : 'not-consumed'}${runTerminalReason ? ` (${runTerminalReason})` : ''}`,
            },
          ]);
        })
        .catch((error: unknown) => {
          setCallbackLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'steerRejected',
              summary: error instanceof Error ? error.message : 'steer outcome rejected',
            },
          ]);
        });
    },
    [view],
  );

  // Derive "is a run in progress?" from the latest visible message's owning Run
  // status. Stop is shown ONLY while the run is actively streaming ('active'). A
  // 'suspended' run is paused awaiting input — a client tool result, or a
  // tool-approval decision — so there is no live stream to abort: the user
  // proceeds via the approval card, and the bar shows Send. Terminal statuses
  // ('complete' | 'cancelled' | 'error') also show Send.
  const latestRun = runOf(messages.at(-1)?.codecMessageId ?? '');
  const latestRunId = latestRun?.runId;
  const isRunInProgress = latestRunId !== undefined && latestRun?.status === 'active';
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
        // Drop the local handle — the SDK marks it dead and rejects further
        // steer() calls synchronously, so the entry would just sit here.
        activeRunsRef.current.delete(event.runId);
      }
      setCallbackLog((prev) => [...prev, { time: Date.now(), type, summary }]);
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

  const unfinishedScenarios = useDemoProgress(scenarios, messages, branchSelection, runOf, ablyMessages);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Snap-to-live-edge callback published by the transcript; sending always jumps
  // to the bottom so the new turn and its streamed reply are in view.
  const scrollToEndRef = useRef<(() => void) | null>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  const handleToolApprove = useCallback(
    (codecMessage: { codecMessageId: string }, toolPart: ToolUIPart | DynamicToolUIPart) => {
      const run = view.runOf(codecMessage.codecMessageId);
      if (!run) return;
      wake(
        view.send(
          [
            uiMessageCodec.createToolApprovalResponse(codecMessage.codecMessageId, {
              toolCallId: toolPart.toolCallId,
              approved: true,
            }),
          ],
          { runId: run.runId },
        ),
      );
    },
    [view, wake],
  );

  const handleToolDeny = useCallback(
    (codecMessage: { codecMessageId: string }, toolPart: ToolUIPart | DynamicToolUIPart) => {
      const run = view.runOf(codecMessage.codecMessageId);
      if (!run) return;
      wake(
        view.send(
          [
            uiMessageCodec.createToolApprovalResponse(codecMessage.codecMessageId, {
              toolCallId: toolPart.toolCallId,
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
    <ChatShell
      title={headerTitle}
      links={headerLinks}
      channelName={chatId}
      clientId={clientId}
      suggestions={unfinishedScenarios}
      onSelectPrompt={handleSelectPrompt}
      input={input}
      onInputChange={setInput}
      inputRef={inputRef}
      inputPlaceholder="Type a message... — or /steer <text> to steer the active run"
      onSend={(text) => {
        // `/steer <text>` targets the latest active Run via activeRun.steer(...) —
        // a follow-up user message inside the running Run rather than a fresh
        // send. The agent's run.hasInput() loop picks it up at the next iteration.
        const steerMatch = /^\/steer\s+(.+)$/.exec(text);
        if (steerMatch) {
          steerActiveRun(steerMatch[1]?.trim() ?? '');
          return;
        }
        scrollToEndRef.current?.();
        wake(view.send(uiMessageCodec.createUserMessage(userMessage(text))));
      }}
      onStop={() => {
        if (!latestRunId) return;
        // Stop only shows for an ACTIVE run, so a live agent is attached:
        // publishing the cancel signal makes it abort and publish run-end, which
        // flips the run to a terminal status and reverts Stop to Send.
        void session.cancel(latestRunId);
      }}
      isRunning={isRunInProgress}
      extraSlot={extraSlot}
      transcript={
        <BranchingMessageList
          messages={messages}
          hasOlder={hasOlder}
          loading={loading}
          view={{ branchSelection, runOf }}
          onLoadOlder={() => void loadOlder()}
          onRegenerate={(cm) => wake(view.regenerate(cm.codecMessageId))}
          onEdit={(cm, text) =>
            wake(view.edit(cm.codecMessageId, [uiMessageCodec.createUserMessage(userMessage(text))]))
          }
          onToolApprove={handleToolApprove}
          onToolDeny={handleToolDeny}
          scrollToEndRef={scrollToEndRef}
          scenarios={scenarios}
          introTitle={introTitle}
          introDescription={introDescription}
        />
      }
      debugPane={
        <DebugPane
          messages={messages}
          ablyMessages={ablyMessages}
          status={status}
          callbackLog={callbackLog}
          statusLog={statusLog}
          clientToolLog={clientToolLog}
          onClearLogs={clearLogs}
        />
      }
    />
  );
}
