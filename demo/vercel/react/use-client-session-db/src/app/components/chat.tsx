'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientRun, RunStatus } from '@ably/ai-transport';
import { isToolUIPart, type UIMessage } from 'ai';
import { createUIMessageSessionCodec, type VercelSessionInput } from '@ably/ai-transport/vercel';
import { useMessagesWithSeed } from '@ably/ai-transport/vercel/react';
import {
  ChatShell,
  LinearMessageList,
  DebugPane,
  useDemoProgress,
  COMMON_SCENARIOS,
  SessionHooks,
  userMessage,
  wakeAgent,
  type MessageStatus,
  type Scenario,
  type DemoStepId,
  type CallbackLogEntry,
  type ClientToolLogEntry,
} from '@ably-ai-demos/frontend';

import { useClientTools } from '../hooks/use-client-tools';

const { useClientSession, useAblyMessages, useTree } = SessionHooks;
const uiMessageCodec = createUIMessageSessionCodec();

// The scenarios this linear database-hydration demo can drive. The three tool
// scenarios plus multi-tab and cancel are shared, authored once in
// COMMON_SCENARIOS; database hydration is unique to this demo. Branching (edit /
// regenerate) and the LiveObjects checklist are omitted — this demo is linear
// and has no checklist.
function pickCommon(ids: readonly DemoStepId[]): Scenario[] {
  return ids.flatMap((id) => COMMON_SCENARIOS.filter((scenario) => scenario.id === id));
}

// Intro-only gesture (no `id`): a reload can't be detected from the conversation,
// so it is never offered as a chip or tracked — it only appears in the intro.
const DB_HYDRATION: Scenario = {
  tag: 'Database hydration',
  title: 'Database hydration',
  gesture: 'send a few turns, then reload the page',
  blurb:
    'The agent persists each completed run to the store. On reload the demo seeds from the database and reconciles it ' +
    'with the live channel at the seam, so the conversation comes back exactly once — no duplicates, no gaps.',
};

const SCENARIOS: readonly Scenario[] = [
  ...pickCommon(['server-weather', 'client-weather', 'approval-forecast']),
  DB_HYDRATION,
  ...pickCommon(['multi-tab', 'cancel']),
  // The observability walkthrough entry (no `id`) — intro-only.
  ...COMMON_SCENARIOS.filter((scenario) => scenario.id === undefined),
];

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
function bubbleStatus(status: RunStatus | undefined): MessageStatus | undefined {
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
  // codec-message-ids), independent of the linear list we render. The fork
  // resolves its parent + the run's messages from the run node (getRunNode).
  const { getRunNode } = useTree();
  useClientTools(view, getRunNode, clientId, api, recordClientTool);

  // Track active ClientRun handles by their resolved run-id so /steer can
  // target the live one. Cleaned up on run-end via the tree.on('run') hook
  // below. A ref instead of state — only the steer call site reads it, and
  // re-rendering is unnecessary.
  const activeRunsRef = useRef<Map<string, ClientRun<VercelSessionInput, UIMessage>>>(new Map());

  // Wake the agent for a freshly-sent run by POSTing its invocation pointer.
  // The core session never sends HTTP — the app owns the trigger. Send sites
  // pass the `view.send*` promise; a POST failure is surfaced in the log.
  const wake = useCallback(
    (runPromise: Promise<ClientRun<VercelSessionInput, UIMessage>>) => {
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
        // Drop the local steer handle for a run that has ended, keeping the map
        // bounded. steer() on a dead handle rejects anyway, so this is only
        // housekeeping.
        activeRunsRef.current.delete(event.runId);
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

  // Derive the still-unfinished scenarios from the conversation tree — the
  // View's CodecMessage list (codec-message-ids), its branch/run lookups, and
  // the raw channel messages (for the cancel signal). Stable across renders so
  // the demo-progress memo does not thrash.
  const branchSelection = useCallback((codecMessageId: string) => view.branchSelection(codecMessageId), [view]);
  const runOf = useCallback((codecMessageId: string) => view.runOf(codecMessageId), [view]);
  const unfinishedScenarios = useDemoProgress(SCENARIOS, view.getMessages(), branchSelection, runOf, ablyMessages);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Snap-to-live-edge callback published by the transcript; sending always
  // jumps to the bottom so the new turn and its streamed reply are in view.
  const scrollToEndRef = useRef<(() => void) | null>(null);
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
          if (!isToolUIPart(part)) continue;
          if (part.toolCallId === toolCallId) return codecMessageId;
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
        view.send([uiMessageCodec.createToolApprovalResponse(codecMessageId, { toolCallId, approved: true })], {
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
            uiMessageCodec.createToolApprovalResponse(codecMessageId, {
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
    (message: UIMessage, index: number): MessageStatus | undefined => {
      if (message.role !== 'assistant') return undefined;
      if (index === messages.length - 1) return bubbleStatus(latestRun?.status) ?? 'complete';
      return 'complete';
    },
    [messages.length, latestRun],
  );

  // Steer the active Run with a follow-up user message. Looks up the latest
  // active run by walking the View's run list newest-first; the handle's
  // .steer() returns { published, outcome } which we log so the demo
  // visualises consumed / not-consumed at run-end. Unlike a plain send, a
  // steer folds into the SAME run — it never cancels or starts a new run, so
  // the whole steered turn persists as one unit when that run completes.
  const steerActiveRun = useCallback(
    (text: string) => {
      const runs = view.runs();
      const active = [...runs].reverse().find((r) => r.status === 'active' || r.status === 'suspended');
      if (!active) {
        setCallbackLog((prev) => [
          ...prev,
          {
            time: Date.now(),
            type: 'steerRejected',
            summary: 'no active run to steer — send a message first',
          },
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
            {
              time: Date.now(),
              type: 'steerPublished',
              summary: `${head}, serial=${serial ?? '?'}`,
            },
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

  const handleSend = useCallback(
    (text: string) => {
      scrollToEndRef.current?.();
      // `/steer <text>` targets the latest active Run via steerActiveRun — a
      // follow-up user message that folds into the running Run rather than a
      // fresh send. The agent's run.hasInput() loop picks it up at the next
      // inference pass. This bypasses the cancel-and-replace below precisely so
      // the run is NOT cancelled.
      const steerMatch = /^\/steer\s+(.+)$/.exec(text);
      if (steerMatch) {
        steerActiveRun(steerMatch[1]?.trim() ?? '');
        return;
      }
      // Linear history: cancel any still-active response before starting a new
      // run, so the seam reconciliation only ever meets complete (or cancelled)
      // runs. Then send over the session view and wake the agent.
      void (async () => {
        try {
          if (latestRun?.status === 'active') await session.cancel(latestRun.runId);
        } catch {
          // best-effort cancel; the send below still proceeds
        }
        wake(view.send(uiMessageCodec.createUserMessage(userMessage(text))));
      })();
    },
    [latestRun, session, view, wake, steerActiveRun],
  );

  return (
    <ChatShell
      title="Ably AI — ClientSession (DB hydration)"
      channelName={chatId}
      clientId={clientId}
      input={input}
      onInputChange={setInput}
      inputRef={inputRef}
      onSend={handleSend}
      onStop={() => {
        if (!latestRun) return;
        // Stop only shows for an ACTIVE run, so a live agent is attached:
        // publishing the cancel signal makes it abort and publish run-end,
        // which flips the run to a terminal status and reverts Stop to Send.
        void session.cancel(latestRun.runId);
      }}
      isRunning={isRunInProgress}
      suggestions={unfinishedScenarios}
      onSelectPrompt={handleSelectPrompt}
      transcript={
        <LinearMessageList
          messages={messages}
          statusOf={statusOf}
          onToolApprove={(toolPart) => handleToolApprove(toolPart.toolCallId)}
          onToolDeny={(toolPart) => handleToolDeny(toolPart.toolCallId)}
          scrollToEndRef={scrollToEndRef}
          scenarios={SCENARIOS}
        />
      }
      debugPane={
        <DebugPane
          messages={codecMessages}
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
