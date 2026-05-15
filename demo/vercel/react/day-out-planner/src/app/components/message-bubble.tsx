'use client';

import type { UIMessage, DynamicToolUIPart } from 'ai';

interface MessageBubbleProps {
  message: UIMessage;
  headers: Record<string, string> | undefined;
  ownName: string;
}

function ToolLine({ part }: { part: DynamicToolUIPart }) {
  const label = part.toolName;
  const state = part.state;

  const summary = (() => {
    if (state === 'output-available') {
      // CAST: tool outputs are typed as unknown; our itinerary tools return { ok, id, name }.
      const out = part.output as { name?: string; id?: string } | undefined;
      if (label === 'addItineraryItem' || label === 'updateItineraryItem') {
        return `${label === 'addItineraryItem' ? 'added' : 'updated'} ${out?.name ?? out?.id ?? ''}`;
      }
      if (label === 'removeItineraryItem') {
        return `removed ${out?.id ?? ''}`;
      }
      return label;
    }
    if (state === 'output-error') {
      return `${label} (error)`;
    }
    return `${label}...`;
  })();

  return <div className="mt-1 text-[11px] text-zinc-500 italic">↳ {summary}</div>;
}

export function MessageBubble({ message, headers, ownName }: MessageBubbleProps) {
  const role = message.role;
  const senderClientId = headers?.['x-ably-run-client-id'];
  const status = headers?.['x-ably-status'];

  const isAssistant = role === 'assistant';
  const isOwn = !isAssistant && senderClientId === ownName;
  const senderLabel = isAssistant ? 'bernard' : (senderClientId ?? 'someone');

  const bubble = isAssistant
    ? 'bg-amber-950/40 text-amber-100 border border-amber-900/40'
    : isOwn
      ? 'bg-zinc-700 text-zinc-100'
      : 'bg-zinc-800 text-zinc-200';

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className="mb-0.5 text-[11px] text-zinc-500 px-1">
          <span className={isAssistant ? 'text-amber-400' : ''}>{senderLabel}</span>
        </div>
        <div className={`rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${bubble}`}>
          {message.parts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            if (part.type === 'dynamic-tool')
              return (
                <ToolLine
                  key={i}
                  part={part}
                />
              );
            return null;
          })}
          {isAssistant && status === 'streaming' && (
            <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-amber-500/60 animate-pulse rounded-sm align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
}
