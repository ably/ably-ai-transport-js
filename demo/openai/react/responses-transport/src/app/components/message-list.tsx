'use client';

import { useState, type RefObject } from 'react';
import type { OpenAIMessage } from '@ably/ai-transport/openai';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';
import { ArrowDownIcon, Loader2Icon } from 'lucide-react';
import { Button } from '@ably-ai-demos/frontend/components/ui/button';
import { IntroCard } from '@ably-ai-demos/frontend/components/intro-card';
import { useStickToBottom } from '@ably-ai-demos/frontend/hooks/use-stick-to-bottom';
import { MessageBubble } from './message-bubble';
import { DEMO_SCENARIOS, INTRO_DESCRIPTION, INTRO_TITLE } from '../lib/intro-content';
import { collectToolCallStates, collectToolOutputs, toDisplayParts } from '../display';

interface ViewLookupApi {
  branchSelection: (codecMessageId: string) => BranchHandle<OpenAIMessage>;
  runOf: (codecMessageId: string) => RunInfo | undefined;
}

interface MessageListProps {
  // Visible messages paired with their codec-message-ids. The list keys all
  // View correlation (runOf / branchSelection / edit / regenerate) on the
  // codec-message-id, never a domain message id.
  messages: CodecMessage<OpenAIMessage>[];
  hasOlder: boolean;
  loading: boolean;
  view: ViewLookupApi;
  onLoadOlder: () => void;
  onRegenerate: (codecMessageId: string) => void;
  onEdit: (codecMessageId: string, newText: string) => void;
  // Filled with a callback that re-pins the transcript to the bottom, so the
  // container can scroll to the latest after sending.
  scrollToEndRef: RefObject<(() => void) | null>;
  // Approve / deny a gated tool call. The codec-message-id addresses the
  // assistant message the approval folds onto; the call_id names the gated call.
  onApproveTool: (codecMessageId: string, callId: string) => void;
  onDenyTool: (codecMessageId: string, callId: string) => void;
}

function LoadingHistory() {
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin" />
      Loading history…
    </div>
  );
}

export function MessageList({
  messages,
  hasOlder,
  loading,
  view,
  onLoadOlder,
  onRegenerate,
  onEdit,
  scrollToEndRef,
  onApproveTool,
  onDenyTool,
}: MessageListProps) {
  const { scrollRef, handleScroll, showJumpToLatest, jumpToLatest } = useStickToBottom(messages, scrollToEndRef, () => {
    // History pagination triggers only at the very top of the scrollback, and
    // never while a page is already loading.
    if (hasOlder && !loading) onLoadOlder();
  });

  // A run splits its work across messages, so a function_call and its
  // function_call_output land in separate messages. Collect every output up
  // front, keyed by call_id, so a call's tool card can show a result published
  // in a sibling message.
  const allMessages = messages.map(({ message }) => message);
  const toolOutputs = collectToolOutputs(allMessages);
  // A gated call's approval state is published on its own message, separate from
  // the function_call, so collect it up front too, keyed by call_id.
  const toolStates = collectToolCallStates(allMessages);

  // Hide messages that render nothing — a message holding only
  // function_call_output items, or only a tool-approval-request's state,
  // produces no parts (its content shows on the call's message), so it would
  // otherwise draw an empty bubble.
  const visibleMessages = messages.filter(({ message }) => toDisplayParts(message, toolOutputs, toolStates).length > 0);

  // Runs whose output is visible carry their terminal error on their own
  // assistant bubble(s). A run that failed before producing any output has no
  // such bubble, so its error renders under the triggering user message
  // instead — `runOf` resolves an input to its selected reply run, so a
  // successful regenerate replaces the errored run and the error disappears.
  const runsWithVisibleOutput = new Set(
    visibleMessages
      .filter(({ message }) => message.role === 'assistant')
      .flatMap(({ codecMessageId }) => view.runOf(codecMessageId)?.runId ?? []),
  );

  // Empty conversation: show the onboarding intro from the top. Kept rendered
  // once messages have existed so a transient empty re-emission mid-flow does
  // not flash the intro-only state back in.
  const [hadMessages, setHadMessages] = useState(false);
  if (visibleMessages.length > 0 && !hadMessages) setHadMessages(true);
  if (visibleMessages.length === 0 && !hadMessages) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <IntroCard
          scenarios={DEMO_SCENARIOS}
          title={INTRO_TITLE}
          description={INTRO_DESCRIPTION}
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
            scenarios={DEMO_SCENARIOS}
            title={INTRO_TITLE}
            description={INTRO_DESCRIPTION}
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

          {visibleMessages.map(({ codecMessageId, message }) => {
            // Project the owning Run + branch-selection bundle into primitives
            // at this glue layer so the MessageBubble component stays free of
            // transport type dependencies. The bundle is total — safe to
            // destructure for any message; non-anchor bubbles return
            // `siblings = [message]` (length 1) so the bubble's render condition
            // uses `hasSiblings`. All correlation keys on the codec-message-id.
            const run = view.runOf(codecMessageId);
            const branch = view.branchSelection(codecMessageId);
            // Translate the literal Run lifecycle state to the bubble's
            // rendering vocabulary: `'active'` → `'streaming'`.
            const bubbleStatus = run?.status === 'active' ? 'streaming' : run?.status;
            // The run's terminal error, placed per the rule above: on the run's
            // assistant output when any is visible, else on the triggering user
            // bubble.
            const errorMessage =
              run?.status === 'error' && (message.role === 'assistant' || !runsWithVisibleOutput.has(run.runId))
                ? run.error.message
                : undefined;
            return (
              <MessageBubble
                key={codecMessageId}
                message={message}
                toolOutputs={toolOutputs}
                toolStates={toolStates}
                clientId={run?.clientId || undefined}
                runId={run?.runId}
                status={bubbleStatus}
                errorMessage={errorMessage}
                hasSiblings={branch.hasSiblings}
                siblingCount={branch.siblings.length}
                selectedIndex={branch.index}
                onSelectSibling={(index) => {
                  branch.select(index);
                }}
                onRegenerate={message.role === 'assistant' ? () => onRegenerate(codecMessageId) : undefined}
                onEdit={message.role === 'user' ? (text) => onEdit(codecMessageId, text) : undefined}
                onApproveTool={(callId) => onApproveTool(codecMessageId, callId)}
                onDenyTool={(callId) => onDenyTool(codecMessageId, callId)}
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
