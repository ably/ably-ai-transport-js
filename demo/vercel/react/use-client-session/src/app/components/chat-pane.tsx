'use client';

import { useCallback } from 'react';
import type * as Ably from 'ably';
import type { UIMessage } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { ClientSession } from '@ably/ai-transport';
import type { VercelEvent, VercelProjection } from '@ably/ai-transport/vercel';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';
import { MessageQueue } from './message-queue';
import { DebugPane } from './debug-pane';
import { useClientTools } from '../hooks/use-client-tools';
import { useMessageQueue } from '../hooks/use-message-queue';
import { userMessageEvent } from '../helpers';

interface ChatPaneProps {
  label: string;
  session: ClientSession<VercelEvent, VercelProjection, UIMessage>;
  /** The reactive ViewHandle from useView or useCreateView. */
  view: ViewHandle<VercelEvent, VercelProjection, UIMessage>;
  /** Raw Ably messages for the debug pane. */
  ablyMessages: Ably.InboundMessage[];
  activeRuns: Map<string, Set<string>>;
  clientId: string | undefined;
}

export function ChatPane({ label, session, view, ablyMessages, activeRuns, clientId }: ChatPaneProps) {
  useClientTools(view, clientId);
  const queue = useMessageQueue(session, view.sendEvent);

  const handleToolApprove = useCallback(
    (msgId: string, toolCallId: string) => {
      const node = view.getNode(msgId);
      const runId = node?.headers['x-ably-run-id'];
      if (!runId) return;
      view.sendEvent([{ type: 'tool-approval-response', toolCallId, approved: true }], { runId });
    },
    [view],
  );

  const handleToolDeny = useCallback(
    (msgId: string, toolCallId: string) => {
      const node = view.getNode(msgId);
      const runId = node?.headers['x-ably-run-id'];
      if (!runId) return;
      view.sendEvent([{ type: 'tool-approval-response', toolCallId, approved: false, reason: 'User denied' }], {
        runId,
      });
    },
    [view],
  );

  return (
    <div className="flex flex-1 min-w-0 min-h-0">
      <div className="flex flex-1 flex-col min-w-0">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
        </div>
        <MessageList
          view={view}
          onRegenerate={(id) => view.regenerate(id)}
          onEdit={(id, text) => view.edit(id, [userMessageEvent(text)])}
          onToolApprove={handleToolApprove}
          onToolDeny={handleToolDeny}
        />
        <MessageQueue queue={queue} />
        <InputBar
          session={session}
          send={view.sendEvent}
          activeRuns={activeRuns}
          clientId={clientId}
          queue={queue}
        />
      </div>
      <DebugPane
        messages={view.nodes.map((n) => n.message)}
        ablyMessages={ablyMessages}
        activeRuns={activeRuns}
        inline
      />
    </div>
  );
}
