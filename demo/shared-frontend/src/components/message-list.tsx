'use client';

import { useState, type RefObject } from 'react';
import { ArrowDownIcon } from 'lucide-react';
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';
import { Button } from './ui/button';
import { MessageBubble, type MessageStatus } from './message-bubble';
import { IntroCard } from './intro-card';
import type { Scenario } from '../lib/progress-steps';
import { useStickToBottom } from '../hooks/use-stick-to-bottom';

interface LinearMessageListProps {
  /** The linear conversation to render (e.g. useChat's `messages`, or a seeded list). */
  messages: UIMessage[];
  /**
   * The live status for a message at a given index — typically `streaming` /
   * `error` / `complete` for the last assistant message, `undefined` otherwise.
   */
  statusOf: (message: UIMessage, index: number) => MessageStatus | undefined;
  /** Approve a pending tool call; receives the tool part. */
  onToolApprove?: (toolPart: ToolUIPart | DynamicToolUIPart) => void;
  /** Deny a pending tool call; receives the tool part. */
  onToolDeny?: (toolPart: ToolUIPart | DynamicToolUIPart) => void;
  /** Whether an older history page is available. Pairs with `onLoadOlder`. */
  hasOlder?: boolean;
  /** Request the next older history page. Pairs with `hasOlder`. */
  onLoadOlder?: () => void;
  /** Receives a "snap to the live edge" callback while mounted; the composer calls it on send. */
  scrollToEndRef: RefObject<(() => void) | null>;
  /** Intro-card scenarios. Defaults to the shared baseline. */
  scenarios?: readonly Scenario[];
  /** Intro-card heading. */
  introTitle?: string;
  /** Intro-card blurb. */
  introDescription?: string;
}

/**
 * A linear transcript over a plain message list — no branch navigation,
 * edit/regenerate, or run-metadata badges. Each message renders through the
 * shared {@link MessageBubble} with its extras omitted. When both `hasOlder`
 * and `onLoadOlder` are provided, a "Load older messages" affordance renders
 * at the top of the scrollback.
 */
export function LinearMessageList({
  messages,
  statusOf,
  onToolApprove,
  onToolDeny,
  hasOlder,
  onLoadOlder,
  scrollToEndRef,
  scenarios,
  introTitle,
  introDescription,
}: LinearMessageListProps) {
  const { scrollRef, handleScroll, showJumpToLatest, jumpToLatest } = useStickToBottom(messages, scrollToEndRef);

  const [hadMessages, setHadMessages] = useState(false);
  if (messages.length > 0 && !hadMessages) setHadMessages(true);
  if (messages.length === 0 && !hadMessages) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <IntroCard
          scenarios={scenarios}
          title={introTitle}
          description={introDescription}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="message-viewport"
        className="scroll-fade-b min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div
          data-testid="messages"
          className="flex flex-col gap-6"
        >
          <IntroCard
            scenarios={scenarios}
            title={introTitle}
            description={introDescription}
          />
          {hasOlder && onLoadOlder && (
            <div className="text-center">
              <Button
                variant="ghost"
                size="xs"
                onClick={onLoadOlder}
                data-testid="load-older"
                className="text-muted-foreground"
              >
                Load older messages
              </Button>
            </div>
          )}
          {messages.map((message, index) => {
            const status = statusOf(message, index);
            return (
              <div
                key={message.id}
                data-testid="message"
                data-role={message.role}
                data-id={message.id}
                data-state={status}
              >
                <MessageBubble
                  message={message}
                  clientId={undefined}
                  runId={undefined}
                  stepId={undefined}
                  stepCount={0}
                  status={status}
                  onToolApprove={onToolApprove}
                  onToolDeny={onToolDeny}
                />
              </div>
            );
          })}
        </div>
      </div>

      {showJumpToLatest && (
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          onClick={jumpToLatest}
          data-testid="scroll-to-latest"
          aria-label="Scroll to latest"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border shadow-md"
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
}
