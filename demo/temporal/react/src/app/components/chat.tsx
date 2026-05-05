'use client';

import { useCallback, useEffect, useState } from 'react';
import type * as AI from 'ai';

import type { ChatHandle } from '../providers';
import { userMessage } from '../helpers';
import { Header } from './header';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';

interface ChatProps {
  handle: ChatHandle;
  clientId?: string;
}

export function Chat({ handle, clientId }: ChatProps) {
  const { view } = handle;
  const [messages, setMessages] = useState<readonly AI.UIMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | undefined>(undefined);
  const [isRunning, setIsRunning] = useState(false);

  // The view drives every render input. Run lifecycle (active/complete/aborted)
  // and per-message streaming flags arrive on the same notification — both
  // fall out of `view.runs` and `view.messages` once the SDK has observed the
  // wire events. No raw channel subscription needed.
  useEffect(() => {
    const update = (): void => {
      const next: AI.UIMessage[] = [];
      let streaming: string | undefined;
      for (const node of view.messages) {
        next.push(node.message);
        if (node.streaming) streaming = node.id;
      }
      setMessages(next);
      setStreamingId(streaming);
      setIsRunning(view.runs.some((r) => r.status === 'active'));
    };
    update();
    return view.subscribe(update);
  }, [view]);

  const handleSubmit = useCallback(
    async (text: string) => {
      const run = await view.send(userMessage(text));
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
        // The run was published but the agent never woke; abort the run so
        // its status flips off `'active'` and the UI stops showing it as
        // running. abort() is a no-op on terminal runs, so it's safe even
        // if a stale agent eventually picks up the invocation.
        await run.abort().catch((abortErr: unknown) => {
          console.error('failed to abort orphaned run', abortErr);
        });
      }
    },
    [view],
  );

  const handleStop = useCallback(() => {
    // Abort every currently-active run. Reads `view.runs` inline rather
    // than closing over `activeRuns` so the callback is stable across
    // re-renders (the InputBar's `onStop` prop reference doesn't churn
    // when a run lands or terminates). ClientRun.abort() is a no-op on
    // terminal runs, so racing with run-end observations is safe.
    for (const run of view.runs) {
      if (run.status === 'active') {
        void run.abort().catch((err: unknown) => {
          console.error('failed to abort run', err);
        });
      }
    }
  }, [view]);

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
