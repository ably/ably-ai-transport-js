'use client';

import type { UIMessage } from 'ai';

interface MessageBubbleProps {
  message: UIMessage;
  headers: Record<string, string> | undefined;
  onRegenerate?: () => void;
}

function Badge({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-tight ${color}`}>
      <span className="text-zinc-600">{label}</span>
      <span>{value}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'finished'
      ? 'bg-emerald-950 text-emerald-400'
      : status === 'streaming'
        ? 'bg-amber-950 text-amber-400'
        : status === 'aborted'
          ? 'bg-red-950 text-red-400'
          : 'bg-zinc-900 text-zinc-500';
  return (
    <Badge
      label="status"
      value={status}
      color={color}
    />
  );
}

function bubbleClasses(isUser: boolean, status: string | undefined): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';

  if (isUser) {
    return `${base} bg-zinc-800 text-zinc-200`;
  }

  if (status === 'streaming') {
    return `${base} bg-zinc-900 text-zinc-300 border border-amber-900/40`;
  }
  if (status === 'finished') {
    return `${base} bg-zinc-900 text-zinc-300 border border-emerald-900/40`;
  }
  if (status === 'aborted') {
    return `${base} bg-zinc-900 text-zinc-300 border border-red-900/40`;
  }
  return `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

export function MessageBubble({ message, headers, onRegenerate }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  const role = headers?.['x-ably-role'] ?? message.role;
  const clientId = headers?.['x-ably-turn-client-id'];
  const turnId = headers?.['x-ably-turn-id'];
  const status = headers?.['x-ably-status'];

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className={bubbleClasses(isUser, status)}>
          {message.parts.map((part, i) => (part.type === 'text' ? <span key={i}>{part.text}</span> : null))}
          {!isUser && status === 'streaming' && (
            <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-amber-500/60 animate-pulse rounded-sm align-text-bottom" />
          )}
        </div>
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          {/* Regenerate button (assistant messages) */}
          {onRegenerate && status !== 'streaming' && (
            <button
              onClick={onRegenerate}
              className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors rounded bg-zinc-800/60 px-1.5 py-0.5"
              title="Regenerate response"
            >
              regenerate
            </button>
          )}

          {/* Debug badges */}
          {headers && (
            <>
              <Badge
                label="role"
                value={role}
                color="bg-zinc-900 text-zinc-500"
              />
              {clientId && (
                <Badge
                  label="client"
                  value={clientId}
                  color="bg-zinc-900 text-zinc-500"
                />
              )}
              {turnId && (
                <Badge
                  label="turn"
                  value={turnId.slice(0, 8)}
                  color="bg-zinc-900 text-zinc-500"
                />
              )}
              {status && <StatusBadge status={status} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
