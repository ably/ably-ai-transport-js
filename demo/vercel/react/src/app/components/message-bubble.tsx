'use client';

import type * as AI from 'ai';
import { getToolName, isToolUIPart } from 'ai';

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

function ToolCallCard({ part }: { part: AI.ToolUIPart | AI.DynamicToolUIPart }) {
  const name = getToolName(part);
  const stateColor =
    part.state === 'output-error'
      ? 'border-rose-900/60 text-rose-300'
      : part.state === 'output-available'
        ? 'border-emerald-900/60 text-emerald-300'
        : 'border-amber-900/60 text-amber-300';

  return (
    <div className={`mt-2 rounded-md border ${stateColor} bg-zinc-950/60 px-2 py-1.5 text-xs`}>
      <div className="flex items-center gap-2 font-mono">
        <span className="text-zinc-400">tool</span>
        <span className="text-zinc-200">{name}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide opacity-75">{part.state}</span>
      </div>
      {part.state !== 'input-streaming' && part.input !== undefined && (
        <pre className="mt-1 overflow-x-auto text-[11px] text-zinc-400">{JSON.stringify(part.input, null, 2)}</pre>
      )}
      {part.state === 'output-available' && (
        <pre className="mt-1 overflow-x-auto text-[11px] text-emerald-300/90">
          {JSON.stringify(part.output, null, 2)}
        </pre>
      )}
      {part.state === 'output-error' && <p className="mt-1 text-[11px] text-rose-300/90">{part.errorText}</p>}
    </div>
  );
}

export function MessageBubble({ message, streaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className={bubbleClasses(isUser, streaming)}>
          {message.parts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            if (isToolUIPart(part))
              return (
                <ToolCallCard
                  key={i}
                  part={part}
                />
              );
            return null;
          })}
          {!isUser && streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-amber-500/60 align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
}
