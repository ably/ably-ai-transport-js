'use client';

import type * as Ably from 'ably';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { ClientTransport } from '@ably/ai-transport';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';
import { MessageQueue } from './message-queue';
import { DebugPane } from './debug-pane';
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
  const queue = useMessageQueue(transport, view.send);

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
