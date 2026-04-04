'use client';

import type { UIMessage, DynamicToolUIPart } from 'ai';
import { ToolInvocation } from './tool-invocation';
import { AgentProgressCard, getLatestProgress } from './agent-progress';
import { type AgentStyle, isKnownAgent, getAgentStyle, AGENT_STYLES } from './agent-colors';

interface ProductCardData {
  name: string;
  sku: string;
  price: number;
  colors: string[];
  rating: number;
  reviews: number;
}

interface RefundConfirmationData {
  orderId: string;
  returnId: string;
  productName: string;
  amount: number;
}

function RefundConfirmationCard({
  refund,
  style,
  onSendMessage,
}: {
  refund: RefundConfirmationData;
  style: AgentStyle;
  onSendMessage: (text: string) => void;
}) {
  return (
    <div className={`mt-1.5 rounded-lg bg-zinc-900/80 border ${style.border} p-3`}>
      <div className="text-xs font-medium text-zinc-300 mb-1">Confirm refund</div>
      <div className="text-[11px] text-zinc-400 mb-2">
        {refund.productName} — <span className="text-zinc-200 font-medium">${refund.amount.toFixed(2)}</span> to your original payment method
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onSendMessage(`Yes, please proceed with the refund of $${refund.amount.toFixed(2)} for return ${refund.returnId}`)}
          className={`flex-1 rounded-md bg-emerald-900/40 border border-emerald-800/40 py-1.5 text-[11px] font-medium text-emerald-400 hover:bg-emerald-900/60 transition-colors`}
        >
          Accept refund
        </button>
        <button
          onClick={() => onSendMessage(`No, I'd like to cancel the return ${refund.returnId} for order ${refund.orderId}`)}
          className="flex-1 rounded-md bg-red-950/30 border border-red-900/30 py-1.5 text-[11px] font-medium text-red-400 hover:bg-red-950/50 transition-colors"
        >
          Cancel return
        </button>
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: UIMessage;
  headers: Record<string, string> | undefined;
  onCancelTurn: (turnId: string) => void;
  onSendMessage: (text: string) => void;
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
    return `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
  }
  if (status === 'aborted') {
    return `${base} bg-zinc-900 text-zinc-300 border border-red-900/40`;
  }
  return `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

/**
 * Sub-agent message with progress card.
 * Renders the progress task list, tool results, and final summary.
 */
function SubAgentBubble({
  message,
  status,
  agentId,
  onCancel,
  onSendMessage,
}: {
  message: UIMessage;
  status: string | undefined;
  agentId: string;
  onCancel: (() => void) | undefined;
  onSendMessage: (text: string) => void;
}) {
  const progress = getLatestProgress(message);
  const aborted = status === 'aborted';
  const style = getAgentStyle(agentId);

  // Collect non-progress parts
  const toolParts = message.parts.filter((p) => p.type === 'dynamic-tool');
  const textParts = message.parts.filter((p) => p.type === 'text' && p.text.trim());
  const recsPart = message.parts.find((p) => p.type === 'data-product-recommendations');
  const recs = recsPart ? (recsPart as { type: string; data: { results: ProductCardData[] } }).data.results : [];
  const refundPart = message.parts.find((p) => p.type === 'data-refund-confirmation');
  const refund = refundPart ? (refundPart as { type: string; data: RefundConfirmationData }).data : null;

  return (
    <div className="max-w-[420px]">
      {/* Progress card */}
      {progress && (
        <AgentProgressCard
          progress={progress}
          agentId={agentId}
          aborted={aborted}
          onCancel={onCancel}
        />
      )}

      {/* Tool result cards (render inline below progress) */}
      {toolParts.length > 0 && (
        <div className="mt-1">
          {toolParts.map((part, i) => (
            <ToolInvocation key={i} part={part as DynamicToolUIPart} />
          ))}
        </div>
      )}

      {/* Summary text (appears when workflow completes) */}
      {textParts.length > 0 && (
        <div className={`mt-1.5 rounded-lg bg-zinc-900/80 border ${style.border} px-3 py-2 text-sm text-zinc-300 leading-relaxed`}>
          {textParts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            return null;
          })}
        </div>
      )}

      {/* Product recommendation cards */}
      {recs.length > 0 && (
        <div className="mt-1.5 space-y-1.5">
          {recs.map((p) => (
            <div key={p.sku} className={`rounded-lg bg-zinc-900/80 border ${style.border} p-2.5`}>
              <div className="flex items-start justify-between gap-2">
                <div className="text-xs font-medium text-zinc-300">{p.name}</div>
                <div className="text-xs font-medium text-zinc-200 shrink-0">${p.price}</div>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <div className="text-[11px] text-zinc-500">
                  {p.rating} stars ({p.reviews} reviews) · {p.colors.join(', ')}
                </div>
                <button
                  onClick={() => onSendMessage(`I'd like to buy the ${p.name} (${p.sku})`)}
                  className="shrink-0 rounded-md bg-emerald-900/40 border border-emerald-800/40 px-2.5 py-1 text-[10px] font-medium text-emerald-400 hover:bg-emerald-900/60 transition-colors"
                >
                  Buy
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Refund confirmation card */}
      {refund && (
        <RefundConfirmationCard refund={refund} style={style} onSendMessage={onSendMessage} />
      )}

      {/* Streaming cursor when no progress card is shown yet */}
      {!progress && status === 'streaming' && (
        <div className="rounded-lg bg-zinc-900/80 border border-amber-900/40 px-3 py-2">
          <span className="inline-block w-1.5 h-3.5 bg-amber-500/60 animate-pulse rounded-sm" />
        </div>
      )}
    </div>
  );
}

/** Render basic markdown (bold, italic, hr) as HTML. */
function MarkdownText({ text }: { text: string }) {
  const html = text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^---$/gm, '<hr class="border-zinc-700/50 my-2" />')
    .replace(/\n/g, '<br />');

  return (
    <span
      className="[&_strong]:text-zinc-200 [&_em]:text-zinc-400"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Standard message bubble for user and orchestrator messages.
 */
function StandardBubble({ message, isUser, status }: { message: UIMessage; isUser: boolean; status: string | undefined }) {
  return (
    <div className={bubbleClasses(isUser, status)}>
      {message.parts.map((part, i) => {
        if (part.type === 'text') return <MarkdownText key={i} text={part.text} />;
        if (part.type === 'dynamic-tool')
          return <ToolInvocation key={i} part={part as DynamicToolUIPart} />;
        return null;
      })}
      {!isUser && status === 'streaming' && (
        <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-amber-500/60 animate-pulse rounded-sm align-text-bottom" />
      )}
    </div>
  );
}

/**
 * Infer agent ID from the progress data's agentLabel when the header
 * clientId is missing (e.g. after history reload).
 */
function inferAgentId(message: UIMessage): string | null {
  const progress = getLatestProgress(message);
  if (!progress) return null;
  for (const [id, style] of Object.entries(AGENT_STYLES)) {
    if (style.label === progress.agentLabel) return id;
  }
  // Fallback: use the first known agent ID as a guess
  return null;
}

function HumanAgentBubble({ message }: { message: UIMessage }) {
  return (
    <div className="max-w-[85%]">
      <div className="text-[10px] text-emerald-500/80 font-medium mb-0.5 ml-1">Support Agent</div>
      <div className="rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap bg-emerald-900/30 border border-emerald-800/30 text-emerald-200">
        {message.parts.map((part, i) => {
          if (part.type === 'text') return <MarkdownText key={i} text={part.text} />;
          return null;
        })}
      </div>
    </div>
  );
}

export function MessageBubble({ message, headers, onCancelTurn, onSendMessage }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const status = headers?.['x-ably-status'];
  const clientId = headers?.['x-ably-turn-client-id'];
  const turnId = headers?.['x-ably-turn-id'];

  // Human agent messages — green bubble with label
  const isHumanAgent = clientId === 'support-agent';
  if (isHumanAgent) {
    return (
      <div className="flex justify-start">
        <HumanAgentBubble message={message} />
      </div>
    );
  }

  // Show as sub-agent bubble if the message is from a known agent (by clientId
  // header or inferred from progress data).
  const agentId = clientId && isKnownAgent(clientId) ? clientId : inferAgentId(message);
  const isSubAgent = !isUser && agentId !== null;

  // Provide cancel whenever we have a turnId — the progress card handles
  // visibility based on whether there are incomplete tasks.
  const canCancel = isSubAgent && turnId;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={isUser ? 'max-w-[75%]' : 'max-w-[85%]'}>
        {isSubAgent ? (
          <SubAgentBubble
            message={message}
            status={status}
            agentId={agentId}
            onCancel={canCancel ? () => onCancelTurn(turnId) : undefined}
            onSendMessage={onSendMessage}
          />
        ) : (
          <StandardBubble message={message} isUser={isUser} status={status} />
        )}
      </div>
    </div>
  );
}
