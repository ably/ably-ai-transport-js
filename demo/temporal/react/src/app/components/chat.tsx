'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as AI from 'ai';

import type { ClientRun, RunStatus, StepStatus } from '@ably/ai-transport';
import type { UIMessageCodec } from '@ably/ai-transport/vercel';

import type { ChatHandle } from '../providers';
import { userMessage } from '../helpers';
import { Header } from './header';
import { MessageList, type MessageInfo } from './message-list';
import { InputBar } from './input-bar';

interface ChatProps {
  handle: ChatHandle;
  clientId?: string;
}

type Run = ClientRun<typeof UIMessageCodec>;

/**
 * Run statuses the retry button should appear under. Completed runs are
 * intentionally excluded — there is nothing to retry once the agent
 * reached a clean finish. Failed and aborted runs both surface retry so
 * the user can re-run after a crash or after they hit Stop.
 */
const RETRYABLE: ReadonlySet<RunStatus> = new Set<RunStatus>(['failed', 'aborted']);

/**
 * Build a `messageId -> MessageInfo` map from the view. Step index is
 * assigned per-run by first-arrival order — the first stepId seen on a
 * run is `1`, the next is `2`, etc. Messages without a stepId (typically
 * client user messages) are recorded with `stepIndex: undefined` so they
 * render without a step badge.
 */
const projectMessageInfo = (view: ChatHandle['view']): Map<string, MessageInfo> => {
  const result = new Map<string, MessageInfo>();
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
      stepStatus: node.step?.status,
      stepIndex,
      canonical: node.canonical,
    });
  }
  return result;
};

export function Chat({ handle, clientId }: ChatProps) {
  const { view } = handle;
  const [messages, setMessages] = useState<readonly AI.UIMessage[]>([]);
  const [info, setInfo] = useState<ReadonlyMap<string, MessageInfo>>(new Map());
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

  const retryableMessageId = useMemo<string | undefined>(() => {
    let id: string | undefined;
    for (const node of view.messages) {
      if (node.role !== 'assistant') continue;
      const status = info.get(node.id)?.runStatus;
      if (status !== undefined && RETRYABLE.has(status)) {
        id = node.id;
      }
    }
    return id;
  }, [info, view]);

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
        // The simulated-failure flow fails the activity's first attempt
        // and recovers on Temporal's automatic retry — the run-end on
        // the channel is `'success'`, not `'failed'`. The API call
        // returns 202 either way (the workflow has been queued).
        if (!response.ok) {
          throw new Error(`agent endpoint returned HTTP ${String(response.status)}`);
        }
      } catch (err) {
        console.error('failed to invoke agent', err);
        // The client published a run-start but the workflow never woke
        // (queue down, network blip, etc). Abort so the run flips off
        // 'active' and the UI stops showing it as running. abort() is
        // a no-op on terminal runs, so a worker that picks up the
        // invocation later doesn't fight us.
        await run.abort().catch((abortErr: unknown) => {
          console.error('failed to abort orphaned run', abortErr);
        });
      }
    },
    [view],
  );

  const handleStop = useCallback(() => {
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
