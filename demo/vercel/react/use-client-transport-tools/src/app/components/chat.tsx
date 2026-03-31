'use client';

import { useCallback } from 'react';
import { useChannel } from 'ably/react';
import {
  useClientTransport,
  useSend,
  useActiveTurns,
  useHistory,
  useConversationTree,
  useAblyMessages,
} from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

import { userMessage } from '../helpers';
import type { ToolApproval } from '../helpers';
import { Header } from './header';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';
import { DebugPane } from './debug-pane';

interface ChatProps {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
}

export function Chat({ chatId, clientId, historyLimit }: ChatProps) {
  const { channel } = useChannel({ channelName: chatId });

  const transport = useClientTransport({
    channel,
    codec: UIMessageCodec,
    clientId,
    body: () => ({ id: chatId }),
  });

  const tree = useConversationTree(transport);
  const send = useSend(transport);
  const activeTurns = useActiveTurns(transport);
  const history = useHistory(transport, { limit: historyLimit ?? 30 });
  const ablyMessages = useAblyMessages(transport);

  const handleToolApprove = useCallback(
    (toolCallId: string, toolName: string, input: Record<string, unknown>) => {
      const label = (input as { title?: string; query?: string }).title ?? toolName;
      const approval: ToolApproval = { toolCallId, toolName, input, approved: true };
      send([userMessage(`Approved: read ${label}`)], {
        body: { toolApprovals: [approval] },
      });
    },
    [send],
  );

  const handleToolDeny = useCallback(
    (toolCallId: string, toolName: string, input: Record<string, unknown>) => {
      const label = (input as { title?: string; query?: string }).title ?? toolName;
      const denial: ToolApproval = { toolCallId, toolName, input, approved: false };
      send([userMessage(`Denied: ${label}`)], {
        body: { toolApprovals: [denial] },
      });
    },
    [send],
  );

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header clientId={clientId} />
        <MessageList
          tree={tree}
          hasNext={history.hasNext}
          loading={history.loading}
          onNext={() => history.next()}
          onToolApprove={handleToolApprove}
          onToolDeny={handleToolDeny}
        />
        <InputBar
          transport={transport}
          send={send}
          activeTurns={activeTurns}
          clientId={clientId}
        />
      </div>
      <DebugPane
        messages={tree.messages}
        ablyMessages={ablyMessages}
        activeTurns={activeTurns}
      />
    </div>
  );
}
