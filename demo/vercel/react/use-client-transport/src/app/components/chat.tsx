'use client';

import { useState, useMemo } from 'react';
import { useChannel } from 'ably/react';
import { useClientTransport, useActiveTurns, useView, useAblyMessages } from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

import { userMessage } from '../helpers';
import { useMessageQueue } from '../hooks/use-message-queue';
import { Header } from './header';
import { MessageList } from './message-list';
import { MessageQueue } from './message-queue';
import { InputBar } from './input-bar';
import { DebugPane } from './debug-pane';
import { ChatPane } from './chat-pane';

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

  const view = useView(transport, { limit: historyLimit ?? 30 });
  const secondView = useMemo(() => transport.createView(), [transport]);
  const view2 = useView(secondView, { limit: historyLimit ?? 30 });

  const activeTurns = useActiveTurns(transport);
  const ablyMessages = useAblyMessages(transport);
  const queue = useMessageQueue(transport, view.send);

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
              activeTurns={activeTurns}
              clientId={clientId}
            />
            <div className="w-px bg-zinc-800" />
            <ChatPane
              label="View B"
              transport={transport}
              view={view2}
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
      <DebugPane
        messages={view.nodes.map((n) => n.message)}
        ablyMessages={ablyMessages}
        activeTurns={activeTurns}
      />
    </div>
  );
}
