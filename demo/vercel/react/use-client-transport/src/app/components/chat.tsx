'use client';

import { useState, useCallback } from 'react';
import type { ToolApprovalDecision } from '@ably/ai-transport/vercel';

import { userMessage } from '../helpers';
import { useClientTools } from '../hooks/use-client-tools';
import { useMessageQueue } from '../hooks/use-message-queue';
import { Header } from './header';
import { MessageList } from './message-list';
import { MessageQueue } from './message-queue';
import { InputBar } from './input-bar';
import { DebugPane } from './debug-pane';
import { ChatPane } from './chat-pane';
import { TransportHooks } from '../providers';

const { useClientTransport, useCreateView, useActiveTurns, useView, useAblyMessages } = TransportHooks;

interface ChatProps {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
}

export function Chat({ clientId, historyLimit }: ChatProps) {
  // Transport is created by TransportProvider in page.tsx
  const { transport } = useClientTransport();
  const [split, setSplit] = useState(false);

  const limit = historyLimit ?? 30;
  const view = useView({ limit });
  const splitView = useCreateView({ limit, skip: !split });

  useClientTools(view, clientId);

  const activeTurns = useActiveTurns();
  const ablyMessages = useAblyMessages();
  const queue = useMessageQueue(transport, view.send);

  const handleToolApproved = useCallback(
    (msgId: string, toolCallId: string, input: unknown) => {
      const inputObj = input as Record<string, string> | undefined;
      const label = inputObj?.location ?? toolCallId;
      const decision: ToolApprovalDecision = { toolCallId, approved: true, targetMsgId: msgId };
      view.send([userMessage(`Approved: ${label}`)], {
        body: { toolApprovals: [decision] },
      });
    },
    [view],
  );

  const handleToolDeny = useCallback(
    (msgId: string, toolCallId: string, input: unknown) => {
      const inputObj = input as Record<string, string> | undefined;
      const label = inputObj?.location ?? toolCallId;
      const decision: ToolApprovalDecision = { toolCallId, approved: false, targetMsgId: msgId };
      view.send([userMessage(`Denied: ${label}`)], {
        body: { toolApprovals: [decision] },
      });
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
              transport={transport}
              view={view}
              ablyMessages={ablyMessages}
              activeTurns={activeTurns}
              clientId={clientId}
            />
            <div className="w-px bg-zinc-800" />
            <ChatPane
              label="View B"
              transport={transport}
              view={splitView}
              ablyMessages={ablyMessages}
              activeTurns={activeTurns}
              clientId={clientId}
            />
          </div>
        ) : (
          <>
            <MessageList
              view={view}
              onRegenerate={(id) => view.regenerate(id)}
              onEdit={(id, text) => view.edit(id, [userMessage(text)])}
              onToolApprove={handleToolApproved}
              onToolDeny={handleToolDeny}
            />
            <MessageQueue queue={queue} />
            <InputBar
              transport={transport}
              send={view.send}
              activeTurns={activeTurns}
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
          activeTurns={activeTurns}
        />
      )}
    </div>
  );
}
