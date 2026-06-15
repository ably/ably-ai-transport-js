'use client';

import type { UIMessage, DynamicToolUIPart } from 'ai';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MessageBubbleProps {
  message: UIMessage;
  /** clientId of the message's sender (from its owning run), or undefined if unknown. */
  clientId: string | undefined;
  /** Whether this message is a Bernard reply that is still streaming. */
  streaming: boolean;
  ownName: string;
}

/**
 * Markdown components scoped to a chat bubble. Tight margins, inline-friendly
 * code/quote styling, links open in a new tab.
 */
const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-inside list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-inside list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="[&>p]:inline">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-amber-300 underline decoration-amber-700 hover:text-amber-200"
    >
      {children}
    </a>
  ),
  code: ({ children, className }) =>
    className?.includes('language-') ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-zinc-900/60 px-1 py-0.5 text-[0.85em] text-amber-200">{children}</code>
    ),
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded bg-zinc-900/60 p-2 text-xs">{children}</pre>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-amber-700/60 pl-2 text-amber-200/80">{children}</blockquote>
  ),
  h1: ({ children }) => <h1 className="mb-1 text-sm font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 text-sm font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 text-sm font-medium">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 text-sm font-medium">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-1 text-sm font-medium">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-1 text-sm font-medium">{children}</h6>,
};

function MarkdownText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  );
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

export function MessageBubble({ message, clientId, streaming, ownName }: MessageBubbleProps) {
  const isAssistant = message.role === 'assistant';
  const isOwn = !isAssistant && clientId === ownName;
  const senderLabel = isAssistant ? 'bernard' : (clientId ?? 'someone');

  // Assistants get markdown; whitespace-pre-wrap would interfere with that
  // because markdown collapses whitespace itself.
  const bubble = isAssistant
    ? 'bg-amber-950/40 text-amber-100 border border-amber-900/40'
    : isOwn
      ? 'bg-zinc-700 text-zinc-100 whitespace-pre-wrap'
      : 'bg-zinc-800 text-zinc-200 whitespace-pre-wrap';

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className="mb-0.5 text-[11px] text-zinc-500 px-1">
          <span className={isAssistant ? 'text-amber-400' : ''}>{senderLabel}</span>
        </div>
        <div className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${bubble}`}>
          {message.parts.map((part, i) => {
            if (part.type === 'text') {
              return isAssistant ? (
                <MarkdownText
                  key={i}
                  text={part.text}
                />
              ) : (
                <span key={i}>{part.text}</span>
              );
            }
            if (part.type === 'dynamic-tool')
              return (
                <ToolLine
                  key={i}
                  part={part}
                />
              );
            return null;
          })}
          {isAssistant && streaming && (
            <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-amber-500/60 animate-pulse rounded-sm align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
}
