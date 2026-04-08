'use client';

import { useState, useCallback } from 'react';
import { useChannel } from 'ably/react';
import { useClientTransport, useCreateView, useActiveTurns, useView, useAblyMessages } from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

import { userMessage } from '../helpers';
import { useClientTools } from '../hooks/use-client-tools';
import { useMessageQueue } from '../hooks/use-message-queue';
import { Header } from './header';
import { MessageList } from './message-list';
import { MessageQueue } from './message-queue';
import { InputBar } from './input-bar';
import { DebugPane } from './debug-pane';
import { ChatPane } from './chat-pane';

export interface ToolApproval {
  toolCallId: string;
  toolName: string;
  input: unknown;
  approved: boolean;
  targetMsgId: string;
}

interface ChatProps {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
}

export function Chat({ chatId, clientId, historyLimit }: ChatProps) {
  const { channel } = useChannel({ channelName: chatId });
  const [split, setSplit] = useState(false);

  const transport = useClientTransport({
    channel,
    codec: UIMessageCodec,
    clientId,
    body: () => ({ id: chatId }),
  });

  const limit = historyLimit ?? 30;
  const view = useView(transport, { limit });
  const splitView = useCreateView(split ? transport : undefined, { limit });

  useClientTools(view, clientId);

  const activeTurns = useActiveTurns(transport);
  const ablyMessages = useAblyMessages(transport);
  const queue = useMessageQueue(transport, view.send);

  const handleToolApproved = useCallback(
    (msgId: string, toolCallId: string, toolName: string, input: unknown) => {
      const inputObj = input as Record<string, string> | undefined;
      const label = inputObj?.location ?? toolName;
      const approval: ToolApproval = { toolCallId, toolName, input, approved: true, targetMsgId: msgId };
      view.send([userMessage(`Approved: ${label}`)], {
        body: { toolApprovals: [approval] },
      });
    },
    [view],
  );

  const handleToolDeny = useCallback(
    (msgId: string, toolCallId: string, toolName: string, input: unknown) => {
      const inputObj = input as Record<string, string> | undefined;
      const label = inputObj?.location ?? toolName;
      const approval: ToolApproval = { toolCallId, toolName, input, approved: false, targetMsgId: msgId };
      view.send([userMessage(`Denied: ${label}`)], {
        body: { toolApprovals: [approval] },
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
