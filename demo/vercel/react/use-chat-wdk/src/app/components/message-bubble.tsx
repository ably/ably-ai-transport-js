'use client';

import { isToolUIPart, type UIMessage } from 'ai';

import { clientColor } from '../lib/client-color';
import { shortId } from '../lib/short-id';
import { ToolInvocation } from './tool-invocation';

interface MessageBubbleProps {
  message: UIMessage;
  // Per-message metadata derived from the View at the list-glue layer
  // (see MessageList) and passed as primitives so the bubble stays a pure
  // renderer with no SDK type dependencies.
  clientId: string | undefined;
  runId: string | undefined;
  stepId: string | undefined;
  stepCount: number;
  /** Physical attempts observed for this message's canonical step (see StepInfo.attemptCount). */
  attemptCount: number;
  status: 'streaming' | 'complete' | 'cancelled' | 'error' | 'suspended' | undefined;
  errorMessage?: string;
  onToolApprove?: (approvalId: string) => void;
  onToolDeny?: (approvalId: string) => void;
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
    status === 'complete'
      ? 'bg-emerald-950 text-emerald-400'
      : status === 'streaming'
        ? 'bg-amber-950 text-amber-400'
        : status === 'cancelled' || status === 'error'
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

function bubbleClasses(isUser: boolean, status: string | undefined, userBgClass?: string): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';

  if (isUser) {
    return `${base} ${userBgClass ?? 'bg-zinc-800'} text-zinc-100`;
  }
  if (status === 'streaming') {
    return `${base} bg-zinc-900 text-zinc-300 border border-amber-900/40`;
  }
  if (status === 'complete') {
    return `${base} bg-zinc-900 text-zinc-300 border border-emerald-900/40`;
  }
  if (status === 'cancelled' || status === 'error') {
    return `${base} bg-zinc-900 text-zinc-300 border border-red-900/40`;
  }
  return `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

export function MessageBubble({
  message,
  clientId,
  runId,
  stepId,
  stepCount,
  attemptCount,
  status,
  errorMessage,
  onToolApprove,
  onToolDeny,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const role = message.role;
  const colors = clientId ? clientColor(clientId) : undefined;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className={bubbleClasses(isUser, status, colors?.userBg)}>
          {message.parts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            if (isToolUIPart(part)) {
              const approvalId = part.approval?.id;
              return (
                <ToolInvocation
                  key={i}
                  part={part}
                  onApprove={() => {
                    if (approvalId && onToolApprove) onToolApprove(approvalId);
                  }}
                  onDeny={() => {
                    if (approvalId && onToolDeny) onToolDeny(approvalId);
                  }}
                />
              );
            }
            return null;
          })}
          {!isUser && status === 'streaming' && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-amber-500/60 align-text-bottom" />
          )}
        </div>

        {/* Debug badges — the durable story: which run, which step, and how many
            physical attempts the canonical step took (a WDK retry bumps it). */}
        {runId && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge
              label="role"
              value={role}
              color="bg-zinc-900 text-zinc-500"
            />
            {clientId && (
              <Badge
                label="client"
                value={clientId}
                color={`bg-zinc-900 ${colors?.text ?? 'text-zinc-500'}`}
              />
            )}
            <Badge
              label="run"
              value={shortId(runId)}
              color="bg-zinc-900 text-zinc-500"
            />
            {stepId && (
              <Badge
                label="step"
                value={shortId(stepId) + (stepCount > 1 ? ` +${stepCount - 1}` : '')}
                color="bg-zinc-900 text-zinc-500"
              />
            )}
            {attemptCount > 1 && (
              <Badge
                label="attempt"
                value={String(attemptCount)}
                color="bg-amber-950 text-amber-400"
              />
            )}
            {status && !isUser && <StatusBadge status={status} />}
          </div>
        )}
        {!isUser && status === 'error' && errorMessage && (
          <div className="mt-1 break-words text-[11px] text-red-300">{errorMessage}</div>
        )}
      </div>
    </div>
  );
}
