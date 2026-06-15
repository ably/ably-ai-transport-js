'use client';

import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { VercelInput } from '@ably/ai-transport/vercel';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  view: ViewHandle<VercelInput, UIMessage>;
  ownName: string;
}

/** A user who has scrolled within this many pixels of the bottom counts as "at bottom". */
const AT_BOTTOM_THRESHOLD_PX = 80;

export function MessageList({ view, ownName }: MessageListProps) {
  const { messages, hasOlder, loading, loadOlder, runOf } = view;
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<string | undefined>(undefined);
  // Whether the user was at (or near) the bottom of the scroll container last
  // time we checked. Drives the streaming auto-scroll below: we only follow
  // along if the user wasn't already scrolled up reading history.
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    if (!wasAtBottomRef.current) return;
    const lastId = messages.length > 0 ? messages[messages.length - 1].codecMessageId : undefined;
    const isNewMessage = lastId !== prevLastIdRef.current;
    prevLastIdRef.current = lastId;
    if (isNewMessage) {
      // Smooth on a brand-new message so it doesn't snap jarringly.
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else if (scrollRef.current) {
      // Streaming tokens are appended to the existing last message — keep the
      // viewport pinned to the bottom by hard-setting scrollTop. `smooth`
      // here would visibly lag behind the token stream.
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasAtBottomRef.current = distFromBottom < AT_BOTTOM_THRESHOLD_PX;
    if (hasOlder && !loading && el.scrollTop < 60) {
      void loadOlder();
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
    >
      {hasOlder && (
        <div className="text-center">
          <button
            onClick={() => void loadOlder()}
            disabled={loading}
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Loading...' : 'Load older messages'}
          </button>
        </div>
      )}
      {messages.length === 0 && !loading && (
        <p className="text-sm text-zinc-600 text-center mt-20">
          Say hi to the group — mention <span className="font-mono text-zinc-400">@bernard</span> when you want help
          planning.
        </p>
      )}
      {messages.map(({ codecMessageId, message }) => {
        // The owning run carries who sent the message (clientId) and its
        // lifecycle status; assistant output belongs to the run the inviting
        // user started, so the bubble decides "is this Bernard?" from the role.
        const run = runOf(codecMessageId);
        return (
          <MessageBubble
            key={codecMessageId}
            message={message}
            clientId={run?.clientId || undefined}
            streaming={message.role === 'assistant' && run?.status === 'active'}
            ownName={ownName}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
