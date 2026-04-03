'use client';

import type { UIMessage, UIMessageChunk } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { ClientTransport } from '@ably/ai-transport';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';
import { MessageQueue } from './message-queue';
import { useMessageQueue } from '../hooks/use-message-queue';
import { userMessage } from '../helpers';

interface ChatPaneProps {
  label: string;
  transport: ClientTransport<UIMessageChunk, UIMessage>;
  view: ViewHandle<UIMessageChunk, UIMessage>;
  activeTurns: Map<string, Set<string>>;
  clientId: string | undefined;
}

export function ChatPane({ label, transport, view, activeTurns, clientId }: ChatPaneProps) {
  const queue = useMessageQueue(transport, view.send);

  return (
    <div className="flex flex-1 flex-col min-w-0">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
      </div>
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
    </div>
  );
}
