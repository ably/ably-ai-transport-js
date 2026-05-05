'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as Ably from 'ably';
import type * as AI from 'ai';

import type { ClientRun, RunStatus } from '@ably/ai-transport';
import type { UIMessageCodec } from '@ably/ai-transport/vercel';

import type { ChatHandle } from '../providers';
import { userMessage } from '../helpers';
import { Header } from './header';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';

interface ChatProps {
  handle: ChatHandle;
  ably: Ably.Realtime;
  sessionName: string;
  clientId?: string;
}

type Run = ClientRun<typeof UIMessageCodec>;

/**
 * Per-message metadata projected from the view: which run a node belongs to,
 * the current status of that run (driven entirely by observed lifecycle
 * wires under the symmetric model), and a stable per-run step index so the
 * UI can label `step 1` / `step 2` etc. across retries.
 */
interface MessageInfo {
  runId: string;
  runStatus: RunStatus;
  stepIndex: number | undefined;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(['complete', 'failed', 'aborted']);

/**
 * Build a `messageId -> MessageInfo` map from the view. Step index is
 * assigned per-run by first-arrival order — the first stepId seen on a
 * run is `1`, the next is `2`, etc. Messages without a stepId (typically
 * client user messages) are recorded with `stepIndex: undefined` so they
 * render without a step badge.
 * @param view The view to project from.
 * @returns A map keyed by message id.
 */
const projectMessageInfo = (view: ChatHandle['view']): Map<string, MessageInfo> => {
  const result = new Map<string, MessageInfo>();
  // Per-run step ordering. Rebuilt on every change — the tree is always
  // serial-ordered so this projection is stable.
  const stepIndexByRun = new Map<string, Map<string, number>>();
  const statusByRun = new Map<string, RunStatus>();
  for (const run of view.runs) {
    statusByRun.set(run.id, run.status);
  }
  for (const node of view.messages) {
    let runStepIndex = stepIndexByRun.get(node.runId);
    if (runStepIndex === undefined) {
      runStepIndex = new Map();
      stepIndexByRun.set(node.runId, runStepIndex);
    }
    let stepIndex: number | undefined;
    if (node.stepId !== undefined) {
      stepIndex = runStepIndex.get(node.stepId);
      if (stepIndex === undefined) {
        stepIndex = runStepIndex.size + 1;
        runStepIndex.set(node.stepId, stepIndex);
      }
    }
    result.set(node.id, {
      runId: node.runId,
      runStatus: statusByRun.get(node.runId) ?? 'active',
      stepIndex,
    });
  }
  return result;
};

export function Chat({ handle, clientId }: ChatProps) {
  const { view } = handle;
  const [messages, setMessages] = useState<readonly AI.UIMessage[]>([]);
  const [info, setInfo] = useState<ReadonlyMap<string, MessageInfo>>(new Map());
  // `runs` mirrors the view's run projection. Stable per-id handles are
  // exposed so the Retry button on a terminated bubble can call
  // `run.retry()` directly without a separate lookup.
  const [runs, setRuns] = useState<readonly Run[]>([]);

  useEffect(() => {
    const update = (): void => {
      const next: AI.UIMessage[] = [];
      for (const node of view.messages) {
        next.push(node.message);
      }
      setMessages(next);
      setInfo(projectMessageInfo(view));
      setRuns(view.runs);
    };
    update();
    return view.subscribe(update);
  }, [view]);

  // Derived: any run whose status is 'active' is in flight. Drives the
  // input bar's disabled state and the streaming indicator on the
  // currently-streaming assistant bubble. Under the symmetric model, a
  // retry on a terminated run flips its status back to 'active' as soon
  // as the agent's new step-start is observed — this derived set picks
  // that up automatically without any imperative bookkeeping.
  const activeRuns = useMemo(() => runs.filter((r) => r.status === 'active'), [runs]);
  const isRunning = activeRuns.length > 0;

  // The currently-streaming assistant message id: the latest message
  // belonging to any active run.
  const streamingId = useMemo(() => {
    const activeIds = new Set(activeRuns.map((r) => r.id));
    let id: string | undefined;
    for (const node of view.messages) {
      if (node.role === 'assistant' && activeIds.has(node.runId)) {
        id = node.id;
      }
    }
    return id;
  }, [activeRuns, view]);

  // The message id of the most recent assistant bubble whose run has
  // reached a terminal status — this is the candidate for the Retry
  // button. Only the latest one shows it so the UI doesn't sprout a
  // button on every prior message.
  const retryableMessageId = useMemo<string | undefined>(() => {
    let id: string | undefined;
    for (const node of view.messages) {
      if (node.role !== 'assistant') continue;
      const status = info.get(node.id)?.runStatus;
      if (status !== undefined && TERMINAL.has(status)) {
        id = node.id;
      }
    }
    return id;
  }, [info, view]);

  /**
   * Resolve a `ClientRun` handle by id, preferring the live projection.
   * Used by `handleRetry` to find the run a Retry-button click targets.
   */
  const findRun = useCallback((runId: string): Run | undefined => runs.find((r) => r.id === runId), [runs]);

  const handleSubmit = useCallback(
    async (text: string, simulateFail: boolean) => {
      const run = await view.send(userMessage(text));
      try {
        const response = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...run.toInvocation().toJSON(), simulateFail }),
        });
        // The simulated-failure flow is expected to return HTTP 5xx — the
        // terminal `run-end (failed)` is already on the channel and the
        // UI reflects it via the run status. Only surface non-OK
        // responses as errors when we weren't asking the agent to fail.
        if (!response.ok && !simulateFail) {
          throw new Error(`agent endpoint returned HTTP ${String(response.status)}`);
        }
      } catch (err) {
        console.error('failed to invoke agent', err);
      }
    },
    [view],
  );

  const handleStop = useCallback(() => {
    // Abort every currently-active run. ClientRun.abort() is a no-op when
    // the run has already terminated, so calling on a snapshot that may
    // be racing with run-end observations is safe.
    for (const run of activeRuns) {
      void run.abort().catch((err: unknown) => {
        console.error('failed to abort run', err);
      });
    }
  }, [activeRuns]);

  const handleRetry = useCallback(
    async (messageId: string) => {
      const messageInfo = info.get(messageId);
      if (messageInfo === undefined) return;
      const run = findRun(messageInfo.runId);
      if (run === undefined) return;
      try {
        const invocation = await run.retry();
        const response = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...invocation.toJSON(), simulateFail: false }),
        });
        if (!response.ok) {
          throw new Error(`agent endpoint returned HTTP ${String(response.status)}`);
        }
      } catch (err) {
        console.error('failed to retry run', err);
      }
    },
    [info, findRun],
  );

  return (
    <div className="flex h-dvh flex-col">
      <Header clientId={clientId} />
      <MessageList
        messages={messages}
        streamingId={streamingId}
        info={info}
        retryableMessageId={isRunning ? undefined : retryableMessageId}
        onRetry={(messageId) => void handleRetry(messageId)}
      />
      <InputBar
        onSubmit={(text, simulateFail) => void handleSubmit(text, simulateFail)}
        onStop={isRunning ? handleStop : undefined}
        disabled={isRunning}
      />
    </div>
  );
}
