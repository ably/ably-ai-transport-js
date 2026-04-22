'use client';

import { useCallback } from 'react';
import type * as Ably from 'ably';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { ClientTransport } from '@ably/ai-transport';
import type { ToolApprovalDecision } from '@ably/ai-transport/vercel';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';
import { MessageQueue } from './message-queue';
import { DebugPane } from './debug-pane';
import { useClientTools } from '../hooks/use-client-tools';
import { useMessageQueue } from '../hooks/use-message-queue';
import { userMessage } from '../helpers';

interface ChatPaneProps {
  label: string;
  transport: ClientTransport<UIMessageChunk, UIMessage>;
  /** The reactive ViewHandle from useView or useCreateView. */
  view: ViewHandle<UIMessageChunk, UIMessage>;
  /** Raw Ably messages for the debug pane. */
  ablyMessages: Ably.InboundMessage[];
  activeTurns: Map<string, Set<string>>;
  clientId: string | undefined;
}

export function ChatPane({ label, transport, view, ablyMessages, activeTurns, clientId }: ChatPaneProps) {
  useClientTools(view, clientId);
  const queue = useMessageQueue(transport, view.send);

  const handleToolApprove = useCallback(
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
    <div className="flex flex-1 min-w-0 min-h-0">
      <div className="flex flex-1 flex-col min-w-0">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
        </div>
        <MessageList
          view={view}
          onRegenerate={(id) => view.regenerate(id)}
          onEdit={(id, text) => view.edit(id, [userMessage(text)])}
          onToolApprove={handleToolApprove}
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
      </div>
      <DebugPane
        messages={view.nodes.map((n) => n.message)}
        ablyMessages={ablyMessages}
        activeTurns={activeTurns}
        inline
      />
    </div>
  );
}
