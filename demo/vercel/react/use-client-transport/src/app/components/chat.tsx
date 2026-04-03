'use client';

import { useState, useEffect, useRef } from 'react';
import { useChannel } from 'ably/react';
import { useClientTransport, useActiveTurns, useView, useAblyMessages } from '@ably/ai-transport/react';
import type { View } from '@ably/ai-transport';
import type { UIMessageChunk, UIMessage } from 'ai';
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

/**
 * Create a secondary View lazily when split mode is active, and close it
 * when split mode is deactivated or the component unmounts.
 */
function useSecondView(transport: ReturnType<typeof useClientTransport>, split: boolean, historyLimit: number) {
  const viewRef = useRef<View<UIMessageChunk, UIMessage> | null>(null);

  // Create or close the raw view when split changes
  useEffect(() => {
    if (split && !viewRef.current) {
      viewRef.current = transport.createView();
    }
    return () => {
      if (viewRef.current) {
        viewRef.current.close();
        viewRef.current = null;
      }
    };
  }, [split, transport]);

  const rawView = split ? viewRef.current : null;
  const handle = useView(rawView, rawView ? { limit: historyLimit } : null);
  return { rawView, handle };
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
  const { rawView: secondRawView, handle: view2 } = useSecondView(transport, split, limit);

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
              rawView={transport.view}
              view={view}
              activeTurns={activeTurns}
              clientId={clientId}
            />
            <div className="w-px bg-zinc-800" />
            {secondRawView && (
              <ChatPane
                label="View B"
                transport={transport}
                rawView={secondRawView}
                view={view2}
                activeTurns={activeTurns}
                clientId={clientId}
              />
            )}
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
