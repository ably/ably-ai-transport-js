'use client';

import { useState, useCallback } from 'react';

import { userMessageEvent } from '../helpers';
import { useClientTools } from '../hooks/use-client-tools';
import { useMessageQueue } from '../hooks/use-message-queue';
import { Header } from './header';
import { MessageList } from './message-list';
import { MessageQueue } from './message-queue';
import { InputBar } from './input-bar';
import { DebugPane } from './debug-pane';
import { ChatPane } from './chat-pane';
import { SessionHooks } from '../providers';

const { useClientSession, useCreateView, useActiveRuns, useView, useAblyMessages } = SessionHooks;

interface ChatProps {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
}

export function Chat({ clientId, historyLimit }: ChatProps) {
  // Session is created by ClientSessionProvider in page.tsx
  const { session } = useClientSession();
  const [split, setSplit] = useState(false);

  const limit = historyLimit ?? 30;
  const view = useView({ limit });
  const splitView = useCreateView({ limit, skip: !split });

  useClientTools(view, clientId);

  const activeRuns = useActiveRuns();
  const ablyMessages = useAblyMessages();
  const queue = useMessageQueue(session, view.sendEvent);

  const handleToolApproved = useCallback(
    (msgId: string, toolCallId: string) => {
      const node = view.getNode(msgId);
      const runId = node?.headers['x-ably-run-id'];
      if (!runId) return;
      view.sendEvent([{ type: 'ait-tool-approval', toolCallId, approved: true, targetMsgId: msgId }], { runId });
    },
    [view],
  );

  const handleToolDeny = useCallback(
    (msgId: string, toolCallId: string) => {
      const node = view.getNode(msgId);
      const runId = node?.headers['x-ably-run-id'];
      if (!runId) return;
      view.sendEvent(
        [{ type: 'ait-tool-approval', toolCallId, approved: false, reason: 'User denied', targetMsgId: msgId }],
        { runId },
      );
    },
    [view],
  );

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header
          clientId={clientId}
          split={split}
          onToggleSplit={() => setSplit((s) => !s)}
        />
        {split ? (
          <div className="flex flex-1 min-h-0">
            <ChatPane
              label="View A"
              session={session}
              view={view}
              ablyMessages={ablyMessages}
              activeRuns={activeRuns}
              clientId={clientId}
            />
            <div className="w-px bg-zinc-800" />
            <ChatPane
              label="View B"
              session={session}
              view={splitView}
              ablyMessages={ablyMessages}
              activeRuns={activeRuns}
              clientId={clientId}
            />
          </div>
        ) : (
          <>
            <MessageList
              view={view}
              onRegenerate={(id) => view.regenerate(id)}
              onEdit={(id, text) => view.edit(id, [userMessageEvent(text)])}
              onToolApprove={handleToolApproved}
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
          </>
        )}
      </div>
      {!split && (
        <DebugPane
          messages={view.nodes.map((n) => n.message)}
          ablyMessages={ablyMessages}
          activeRuns={activeRuns}
        />
      )}
    </div>
  );
}
