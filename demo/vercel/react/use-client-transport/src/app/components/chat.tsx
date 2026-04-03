'use client';

import { useChannel } from 'ably/react';
import {
  useClientTransport,
  useSend,
  useRegenerate,
  useEdit,
  useActiveTurns,
  useView,
  useAblyMessages,
} from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

import { userMessage } from '../helpers';
import { useMessageQueue } from '../hooks/use-message-queue';
import { Header } from './header';
import { MessageList } from './message-list';
import { MessageQueue } from './message-queue';
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

  const view = useView(transport, { limit: historyLimit ?? 30 });
  const send = useSend(transport);
  const regenerate = useRegenerate(transport);
  const edit = useEdit(transport);
  const activeTurns = useActiveTurns(transport);
  const ablyMessages = useAblyMessages(transport);
  const queue = useMessageQueue(transport, send);

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header clientId={clientId} />
        <MessageList
          view={view}
          onRegenerate={(id) => regenerate(id)}
          onEdit={(id, text) => edit(id, [userMessage(text)])}
        />
        <MessageQueue queue={queue} />
        <InputBar
          transport={transport}
          send={send}
          activeTurns={activeTurns}
          clientId={clientId}
          queue={queue}
        />
      </div>
      <DebugPane
        messages={view.nodes.map((n) => n.message)}
        ablyMessages={ablyMessages}
        activeTurns={activeTurns}
      />
    </div>
  );
}
