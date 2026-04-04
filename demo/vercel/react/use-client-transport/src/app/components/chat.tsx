'use client';

import { useState } from 'react';
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

  useClientTools(view);

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
