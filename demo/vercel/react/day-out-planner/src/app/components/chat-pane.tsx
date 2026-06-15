'use client';

import { useCallback } from 'react';
import type { UIMessage } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import { UIMessageCodec, type VercelInput } from '@ably/ai-transport/vercel';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';
import { mentionsBernard, userMessage, wakeAgent } from '../helpers';

interface ChatPaneProps {
  view: ViewHandle<VercelInput, UIMessage>;
  ownName: string;
  /** The agent endpoint to POST an invocation to when a message mentions @bernard. */
  api: string;
}

export function ChatPane({ view, ownName, api }: ChatPaneProps) {
  const onSend = useCallback(
    (text: string) => {
      // Every message is published into the shared session, where everyone
      // sees it. view.send returns the run but does not, on its own, wake the
      // agent — publishing and invoking are separate. We only wake Bernard —
      // by POSTing the invocation — when he's mentioned. This is how a durable
      // session lets the app choose when the agent works.
      void view
        .send(UIMessageCodec.createUserMessage(userMessage(text)))
        .then((run) => (mentionsBernard(text) ? wakeAgent(api, run) : undefined))
        .catch((err: unknown) => console.error('failed to send message', err));
    },
    [view, api],
  );

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <MessageList
        view={view}
        ownName={ownName}
      />
      <InputBar onSend={onSend} />
    </div>
  );
}
