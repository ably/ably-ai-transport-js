'use client';

import { useState, type RefObject } from 'react';
import { ArrowDownIcon, Loader2Icon } from 'lucide-react';
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';
import { Button } from './ui/button';
import { MessageBubble, type MessageStatus } from './message-bubble';
import { IntroCard } from './intro-card';
import type { Scenario } from '../lib/progress-steps';
import { useStickToBottom } from '../hooks/use-stick-to-bottom';

interface ViewLookupApi {
  /** Branch-selection handle for a message (siblings + current index + select). */
  branchSelection: (codecMessageId: string) => BranchHandle<UIMessage>;
  /** The owning Run for a message, when known. */
  runOf: (codecMessageId: string) => RunInfo | undefined;
}

interface BranchingMessageListProps {
  /**
   * Visible messages paired with their codec-message-ids. View correlation
   * (runOf / branchSelection) keys on the codec-message-id. The action callbacks
   * receive the whole {@link CodecMessage} so each demo's container reads the id
   * its write path needs — the codec-message-id, or the domain `message.id`.
   */
  messages: CodecMessage<UIMessage>[];
  /** Whether an older history page is available. */
  hasOlder: boolean;
  /** Whether a history page is currently loading. */
  loading: boolean;
  /** View lookups for per-message run metadata and branch selection. */
  view: ViewLookupApi;
  /** Request the next older history page. */
  onLoadOlder: () => void;
  /** Regenerate the assistant reply anchored at this message. */
  onRegenerate: (message: CodecMessage<UIMessage>) => void;
  /** Re-send this user message with edited text (forks a branch). */
  onEdit: (message: CodecMessage<UIMessage>, newText: string) => void;
  /** Approve a pending tool call; receives the message and the tool part. */
  onToolApprove?: (message: CodecMessage<UIMessage>, toolPart: ToolUIPart | DynamicToolUIPart) => void;
  /** Deny a pending tool call; receives the message and the tool part. */
  onToolDeny?: (message: CodecMessage<UIMessage>, toolPart: ToolUIPart | DynamicToolUIPart) => void;
  /** Receives a "snap to the live edge" callback while mounted; the composer calls it on send. */
  scrollToEndRef: RefObject<(() => void) | null>;
  /** Intro-card scenarios. Defaults to the shared baseline. */
  scenarios?: readonly Scenario[];
  /** Intro-card heading. */
  introTitle?: string;
  /** Intro-card blurb. */
  introDescription?: string;
}

// Quiet spinner shown while an older history page is loading.
function LoadingHistory() {
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin" />
      Loading history…
    </div>
  );
}

/**
 * A branching transcript over the View's {@link CodecMessage} list: run-metadata
 * badges, branch navigation, edit/regenerate, and older-history pagination.
 */
export function BranchingMessageList({
  messages,
  hasOlder,
  loading,
  view,
  onLoadOlder,
  onRegenerate,
  onEdit,
  onToolApprove,
  onToolDeny,
  scrollToEndRef,
  scenarios,
  introTitle,
  introDescription,
}: BranchingMessageListProps) {
  const { scrollRef, handleScroll, showJumpToLatest, jumpToLatest } = useStickToBottom(messages, scrollToEndRef, () => {
    // History pagination triggers only at the very top of the scrollback, and
    // never while a page is already loading.
    if (hasOlder && !loading) onLoadOlder();
  });

  // Empty conversation: show the onboarding intro from the top. Kept rendered
  // once messages have existed so a transient empty re-emission mid-flow does
  // not flash the intro-only state back in.
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
        {loading && <LoadingHistory />}
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
          {/* The demo walkthrough stays at the top of the scrollback, above the
              oldest loaded message, so it remains reachable mid-chat. */}
          <IntroCard
            scenarios={scenarios}
            title={introTitle}
            description={introDescription}
          />
          {hasOlder && (
            <div className="text-center">
              <Button
                variant="ghost"
                size="xs"
                onClick={onLoadOlder}
                disabled={loading}
                data-testid="load-older"
                className="text-muted-foreground"
              >
                {loading ? 'Loading...' : 'Load older messages'}
              </Button>
            </div>
          )}
          {loading && <LoadingHistory />}

          {messages.map((codecMessage) => {
            const { codecMessageId, message } = codecMessage;
            const run = view.runOf(codecMessageId);
            const branch = view.branchSelection(codecMessageId);
            // Translate the run's lifecycle state to the bubble's vocabulary:
            // 'active' → 'streaming'.
            const bubbleStatus = run?.status === 'active' ? 'streaming' : run?.status;
            const steps = run?.steps ?? [];
            const lastStep = steps[steps.length - 1];
            return (
              <MessageBubble
                key={codecMessageId}
                message={message}
                clientId={run?.clientId || undefined}
                runId={run?.runId}
                stepId={lastStep?.stepId}
                stepCount={steps.length}
                status={bubbleStatus}
                errorMessage={run?.error?.message}
                hasSiblings={branch.hasSiblings}
                siblingCount={branch.hasSiblings ? branch.siblings.length : undefined}
                selectedIndex={branch.hasSiblings ? branch.index : undefined}
                onSelectSibling={branch.hasSiblings ? (index) => branch.select(index) : undefined}
                onRegenerate={message.role === 'assistant' ? () => onRegenerate(codecMessage) : undefined}
                onEdit={message.role === 'user' ? (text) => onEdit(codecMessage, text) : undefined}
                onToolApprove={onToolApprove ? (toolPart) => onToolApprove(codecMessage, toolPart) : undefined}
                onToolDeny={onToolDeny ? (toolPart) => onToolDeny(codecMessage, toolPart) : undefined}
              />
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
 * edit/regenerate, run-metadata badges, or pagination. Each message renders
 * through the shared {@link MessageBubble} with its extras omitted.
 */
export function LinearMessageList({
  messages,
  statusOf,
  onToolApprove,
  onToolDeny,
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
