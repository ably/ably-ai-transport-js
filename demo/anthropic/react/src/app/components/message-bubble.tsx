'use client';

import type { AgentMessage } from '@ably/ai-transport/anthropic';
import type { SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

interface MessageBubbleProps {
  message: AgentMessage;
  headers: Record<string, string> | undefined;
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
  if (isUser) return `${base} bg-zinc-800 text-zinc-200`;
  if (status === 'streaming') return `${base} bg-zinc-900 text-zinc-300 border border-amber-900/40`;
  if (status === 'finished') return `${base} bg-zinc-900 text-zinc-300 border border-emerald-900/40`;
  if (status === 'aborted') return `${base} bg-zinc-900 text-zinc-300 border border-red-900/40`;
  return `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

/** Extract displayable text from an assistant message's content blocks. */
function renderAssistantContent(msg: SDKAssistantMessage) {
  const message = msg.message as Record<string, unknown>;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) {
    // Fallback: show raw message for debugging
    return <span className="text-zinc-500 text-xs">{JSON.stringify(message, null, 2)}</span>;
  }

  return content.map((block: Record<string, unknown>, i: number) => {
    switch (block.type) {
      case 'text':
        return <span key={i}>{String(block.text ?? '')}</span>;
      case 'thinking':
        return (
          <div
            key={i}
            className="text-zinc-500 italic border-l-2 border-zinc-700 pl-2 my-1"
          >
            {String(block.thinking ?? '')}
          </div>
        );
      case 'tool_use':
        return (
          <div
            key={i}
            className="text-xs bg-zinc-800 rounded px-2 py-1 my-1 font-mono"
          >
            <span className="text-blue-400">{String(block.name ?? 'tool')}</span>
            <span className="text-zinc-600">(</span>
            <span className="text-zinc-400">{JSON.stringify(block.input ?? {})}</span>
            <span className="text-zinc-600">)</span>
          </div>
        );
      default:
        return null;
    }
  });
}

/** Extract displayable text from a user message. */
function renderUserContent(msg: SDKUserMessage) {
  const content = msg.message.content;
  if (typeof content === 'string') return <span>{content}</span>;

  if (Array.isArray(content)) {
    return content.map((block: Record<string, unknown>, i: number) => {
      if (block.type === 'text') return <span key={i}>{String(block.text ?? '')}</span>;
      return null;
    });
  }

  return null;
}

export function MessageBubble({ message, headers }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const role = headers?.['x-ably-role'] ?? (isUser ? 'user' : 'assistant');
  const clientId = headers?.['x-ably-turn-client-id'];
  const turnId = headers?.['x-ably-turn-id'];
  const status = headers?.['x-ably-status'];

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className={bubbleClasses(isUser, status)}>
          {isUser
            ? renderUserContent(message as SDKUserMessage)
            : renderAssistantContent(message as SDKAssistantMessage)}
          {!isUser && status === 'streaming' && (
            <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-amber-500/60 animate-pulse rounded-sm align-text-bottom" />
          )}
        </div>

        {/* Debug badges */}
        {headers && (
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
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
          </div>
        )}
      </div>
    </div>
  );
}
