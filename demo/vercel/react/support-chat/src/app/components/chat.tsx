'use client';

import { useChannel } from 'ably/react';
import { useClientTransport, useActiveTurns, useView } from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

import { useCallback } from 'react';
import type { UIMessage } from 'ai';
import { useClientTools } from '../hooks/use-client-tools';
import { useMessageQueue } from '../hooks/use-message-queue';
import { Header } from './header';
import { MessageList } from './message-list';
import { MessageQueue } from './message-queue';
import { InputBar } from './input-bar';

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

  const limit = historyLimit ?? 30;
  const view = useView(transport, { limit });

  useClientTools(view, clientId);

  const activeTurns = useActiveTurns(transport);
  const queue = useMessageQueue(transport, view.send);

  return (
    <div className="flex h-dvh flex-col">
      <Header clientId={clientId} activeTurns={activeTurns} />
      <MessageList
        view={view}
        onCancelTurn={(turnId) => transport.cancel({ turnId })}
        onSendMessage={useCallback((text: string) => {
          const msg: UIMessage = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
          view.send([msg]);
        }, [view])}
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
  );
}
