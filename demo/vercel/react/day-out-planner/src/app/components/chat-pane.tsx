'use client';

import type { UIMessage, UIMessageChunk } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';

interface ChatPaneProps {
  view: ViewHandle<UIMessageChunk, UIMessage>;
  ownName: string;
}

export function ChatPane({ view, ownName }: ChatPaneProps) {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <MessageList
        view={view}
        ownName={ownName}
      />
      <InputBar send={view.send} />
    </div>
  );
}
