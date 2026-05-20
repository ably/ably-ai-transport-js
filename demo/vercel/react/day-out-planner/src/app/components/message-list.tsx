'use client';

import { useEffect, useRef } from 'react';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  view: ViewHandle<UIMessageChunk, UIMessage>;
  ownName: string;
}

/** A user who has scrolled within this many pixels of the bottom counts as "at bottom". */
const AT_BOTTOM_THRESHOLD_PX = 80;

export function MessageList({ view, ownName }: MessageListProps) {
  const { nodes, hasOlder, loading, loadOlder } = view;
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<string | undefined>(undefined);
  // Whether the user was at (or near) the bottom of the scroll container last
  // time we checked. Drives the streaming auto-scroll below: we only follow
  // along if the user wasn't already scrolled up reading history.
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    if (!wasAtBottomRef.current) return;
    const lastId = nodes.length > 0 ? nodes[nodes.length - 1].message.id : undefined;
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
  }, [nodes]);

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
      {nodes.length === 0 && !loading && (
        <p className="text-sm text-zinc-600 text-center mt-20">
          Say hi to the group — mention <span className="font-mono text-zinc-400">@bernard</span> when you want help
          planning.
        </p>
      )}
      {nodes.map((node) => (
        <MessageBubble
          key={node.message.id}
          message={node.message}
          headers={node.headers}
          ownName={ownName}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
