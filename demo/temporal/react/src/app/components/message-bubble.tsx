'use client';

import type * as AI from 'ai';

interface MessageBubbleProps {
  message: AI.UIMessage;
  streaming: boolean;
}

function bubbleClasses(isUser: boolean, streaming: boolean): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';
  if (isUser) return `${base} bg-zinc-800 text-zinc-200`;
  return streaming
    ? `${base} bg-zinc-900 text-zinc-300 border border-amber-900/40`
    : `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

export function MessageBubble({ message, streaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className={bubbleClasses(isUser, streaming)}>
          {message.parts.map((part, i) => (part.type === 'text' ? <span key={i}>{part.text}</span> : null))}
          {!isUser && streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-amber-500/60 align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
}
