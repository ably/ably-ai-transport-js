'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Ably from 'ably';
import type * as AI from 'ai';

import type { ClientRun } from '@ably/ai-transport';
import type { UIMessageCodec } from '@ably/ai-transport/vercel';

import type { ChatHandle } from '../providers';

// SDK header / wire message names used by the demo. These are part of the
// public wire format; the SDK itself defines them in its `headers.ts` but
// does not currently re-export the constants.
const HEADER_RUN_ID = 'x-ably-run-id';
const WIRE_RUN_END = 'x-ably-run-end';
const WIRE_ABORT = 'x-ably-abort';
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

export function Chat({ handle, ably, sessionName, clientId }: ChatProps) {
  const { view } = handle;
  const [messages, setMessages] = useState<readonly AI.UIMessage[]>([]);
  // Active runs keyed by id so the Stop button can call abort() on whatever
  // run is currently in flight. The map is the source of truth — UI flags
  // (`isRunning`, `streamingId`) are derived from it.
  const [activeRuns, setActiveRuns] = useState<ReadonlyMap<string, Run>>(new Map());
  const activeRunsRef = useRef(activeRuns);
  activeRunsRef.current = activeRuns;

  // Mirror the view's messages into React state, plus track which
  // assistant message belongs to each run so we can mark it as streaming.
  const [assistantByRun, setAssistantByRun] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const update = () => {
      const next: AI.UIMessage[] = [];
      const byRun = new Map<string, string>();
      for (const node of view.messages) {
        next.push(node.message);
        if (node.role === 'assistant') byRun.set(node.runId, node.id);
      }
      setMessages(next);
      setAssistantByRun(byRun);
    };
    update();
    return view.subscribe(update);
  }, [view]);

  // Drop runs from the active map when an `x-ably-run-end` lands on the
  // channel, or when an `x-ably-abort` is observed (the abort signal is
  // itself the run terminal — the agent's `run-end (aborted)` confirmation
  // may follow but isn't required to mark the run done from the UI's
  // perspective).
  useEffect(() => {
    const channel = ably.channels.get(sessionName);
    const dropRun = (runId: string): void => {
      setActiveRuns((prev) => {
        if (!prev.has(runId)) return prev;
        const next = new Map(prev);
        next.delete(runId);
        return next;
      });
    };
    const listener = (message: Ably.InboundMessage) => {
      // CAST: Ably types `extras` as `any`; narrow to read x-ably-run-id.
      const headers = (message.extras as { headers?: Record<string, unknown> } | undefined)?.headers;
      const runId = headers?.[HEADER_RUN_ID];
      if (typeof runId !== 'string') return;
      dropRun(runId);
    };
    void channel.subscribe(WIRE_RUN_END, listener);
    void channel.subscribe(WIRE_ABORT, listener);
    return () => {
      channel.unsubscribe(WIRE_RUN_END, listener);
      channel.unsubscribe(WIRE_ABORT, listener);
    };
  }, [ably, sessionName]);

  const handleSubmit = useCallback(
    async (text: string) => {
      const run = await view.send(userMessage(text));
      setActiveRuns((prev) => new Map(prev).set(run.id, run));
      try {
        const response = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(run.toInvocation().toJSON()),
        });
        if (!response.ok) {
          throw new Error(`agent endpoint returned HTTP ${String(response.status)}`);
        }
      } catch (err) {
        console.error('failed to invoke agent', err);
        setActiveRuns((prev) => {
          if (!prev.has(run.id)) return prev;
          const next = new Map(prev);
          next.delete(run.id);
          return next;
        });
      }
    },
    [view],
  );

  const handleStop = useCallback(() => {
    // Abort every currently-active run. ClientRun.abort() is a no-op when
    // the run has already terminated, so calling on a Map that may be
    // racing with run-end observations is safe.
    for (const run of activeRunsRef.current.values()) {
      void run.abort().catch((err: unknown) => {
        console.error('failed to abort run', err);
      });
    }
  }, []);

  // The currently-streaming assistant message (if any).
  let streamingId: string | undefined;
  for (const runId of activeRuns.keys()) {
    const id = assistantByRun.get(runId);
    if (id !== undefined) streamingId = id;
  }

  const isRunning = activeRuns.size > 0;

  return (
    <div className="flex h-dvh flex-col">
      <Header clientId={clientId} />
      <MessageList
        messages={messages}
        streamingId={streamingId}
      />
      <InputBar
        onSubmit={(text) => void handleSubmit(text)}
        onStop={isRunning ? handleStop : undefined}
        disabled={isRunning}
      />
    </div>
  );
}
