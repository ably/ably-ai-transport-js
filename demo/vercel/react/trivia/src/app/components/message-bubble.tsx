'use client';

import type { UIMessage, DynamicToolUIPart } from 'ai';
import { ToolInvocation } from './tool-invocation';
import { clientColor } from '../lib/client-color';
import { playerFromMessage } from '../lib/trivia';

interface MessageBubbleProps {
  message: UIMessage;
  /**
   * The publisher's clientId from the View's run tracking — used for colour
   * and as the attribution fallback when a message carries no `data-player`
   * part (e.g. it was sent by a non-trivia client on the same channel).
   */
  clientId: string | undefined;
  status: 'streaming' | 'complete' | 'cancelled' | 'error' | 'suspended' | undefined;
}

function bubbleClasses(isUser: boolean, status: string | undefined, userBgClass?: string): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';

  if (isUser) {
    return `${base} ${userBgClass ?? 'bg-zinc-800'} text-zinc-100`;
  }

  if (status === 'streaming') {
    return `${base} bg-zinc-900 text-zinc-300 border border-amber-900/40`;
  }
  if (status === 'cancelled' || status === 'error') {
    return `${base} bg-zinc-900 text-zinc-300 border border-red-900/40`;
  }
  return `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

export function MessageBubble({ message, clientId, status }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  // Sender identity: the message's own data-player part when present, else
  // the run's publisher clientId.
  const player = isUser ? playerFromMessage(message) : undefined;
  const colorKey = player?.clientId ?? clientId;
  const colors = colorKey ? clientColor(colorKey) : undefined;
  const senderLabel = isUser ? (player?.name ?? clientId) : 'Quizmaster';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className={`mb-0.5 text-[10px] ${isUser ? 'text-right' : ''} ${colors?.text ?? 'text-zinc-500'}`}>
          {senderLabel}
        </div>
        <div className={bubbleClasses(isUser, status, colors?.userBg)}>
          {message.parts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            if (part.type === 'dynamic-tool') {
              const toolPart: DynamicToolUIPart = part;
              return (
                <ToolInvocation
                  key={i}
                  part={toolPart}
                />
              );
            }
            // data-player parts are rendered as the sender label above.
            return null;
          })}
          {!isUser && status === 'streaming' && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-amber-500/60 align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
}
