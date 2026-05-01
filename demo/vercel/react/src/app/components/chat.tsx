'use client';

import { useCallback, useEffect, useState } from 'react';
import type * as Ably from 'ably';
import type * as AI from 'ai';

import type { ChatHandle } from '../providers';

// SDK header / wire message names used by the demo. These are part of the
// public wire format; the SDK itself defines them in its `headers.ts` but
// does not currently re-export the constants.
const HEADER_RUN_ID = 'x-ably-run-id';
const WIRE_RUN_END = 'x-ably-run-end';
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

export function Chat({ handle, ably, sessionName, clientId }: ChatProps) {
  const { view } = handle;
  const [messages, setMessages] = useState<readonly AI.UIMessage[]>([]);
  const [activeRunIds, setActiveRunIds] = useState<ReadonlySet<string>>(new Set());

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

  // Drop runs from the active set when an `x-ably-run-end` lands on the channel.
  useEffect(() => {
    const channel = ably.channels.get(sessionName);
    const listener = (message: Ably.InboundMessage) => {
      // CAST: Ably types `extras` as `any`; narrow to read x-ably-run-id.
      const headers = (message.extras as { headers?: Record<string, unknown> } | undefined)?.headers;
      const runId = headers?.[HEADER_RUN_ID];
      if (typeof runId !== 'string') return;
      setActiveRunIds((prev) => {
        if (!prev.has(runId)) return prev;
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    };
    void channel.subscribe(WIRE_RUN_END, listener);
    return () => {
      channel.unsubscribe(WIRE_RUN_END, listener);
    };
  }, [ably, sessionName]);

  const handleSubmit = useCallback(
    async (text: string) => {
      const run = await view.send(userMessage(text));
      setActiveRunIds((prev) => new Set(prev).add(run.id));
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
        setActiveRunIds((prev) => {
          if (!prev.has(run.id)) return prev;
          const next = new Set(prev);
          next.delete(run.id);
          return next;
        });
      }
    },
    [view],
  );

  // The currently-streaming assistant message (if any).
  let streamingId: string | undefined;
  for (const runId of activeRunIds) {
    const id = assistantByRun.get(runId);
    if (id !== undefined) streamingId = id;
  }

  return (
    <div className="flex h-dvh flex-col">
      <Header clientId={clientId} />
      <MessageList
        messages={messages}
        streamingId={streamingId}
      />
      <InputBar
        onSubmit={(text) => void handleSubmit(text)}
        disabled={activeRunIds.size > 0}
      />
    </div>
  );
}
