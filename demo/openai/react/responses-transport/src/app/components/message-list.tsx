'use client';

import { useState, type RefObject } from 'react';
import { ArrowDownIcon, Loader2Icon } from 'lucide-react';
import { Button } from '@ably-ai-demos/frontend/components/ui/button';
import { IntroCard } from '@ably-ai-demos/frontend/components/intro-card';
import { useStickToBottom } from '@ably-ai-demos/frontend/hooks/use-stick-to-bottom';
import { MessageBubble } from './message-bubble';
import { DEMO_SCENARIOS, INTRO_DESCRIPTION, INTRO_TITLE } from '../lib/intro-content';
import { collectToolCallStates, collectToolOutputs, toDisplayParts } from '../display';
import type { RunSummary, ThreadMessage } from '../lib/merge-thread';

interface MessageListProps {
  // The merged thread, in order. All correlation (run status, approvals) keys
  // on each message's transport-message-id and run-id.
  messages: ThreadMessage[];
  // The merged run state, for per-message status and error placement.
  runs: ReadonlyMap<string, RunSummary>;
  // True while history hydration is still paging.
  loading: boolean;
  // Filled with a callback that re-pins the transcript to the bottom, so the
  // container can scroll to the latest after sending.
  scrollToEndRef: RefObject<(() => void) | null>;
  // Approve / deny a gated tool call. The transport-message-id addresses the
  // assistant message the approval merges onto; the call_id names the gated call.
  onApproveTool: (transportMessageId: string, callId: string) => void;
  onDenyTool: (transportMessageId: string, callId: string) => void;
}

function LoadingHistory() {
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin" />
      Loading history…
    </div>
  );
}

export function MessageList({ messages, runs, loading, scrollToEndRef, onApproveTool, onDenyTool }: MessageListProps) {
  // Hydration pages the whole history up front, so there is no fetch to
  // trigger at the top of the scrollback (no onNearTop).
  const { scrollRef, handleScroll, showJumpToLatest, jumpToLatest } = useStickToBottom(messages, scrollToEndRef);

  // A run splits its work across messages, so a function_call and its
  // function_call_output land in separate messages. Collect every output up
  // front, keyed by call_id, so a call's tool card can show a result published
  // in a sibling message.
  const toolOutputs = collectToolOutputs(messages);
  // A gated call's approval state merges onto the message holding the call, but
  // collect it across messages too so pairing stays order-independent.
  const toolStates = collectToolCallStates(messages);

  // A user message has no run-id of its own (the agent mints the run after the
  // send), so resolve it to its reply run via the run-start's trigger stamp.
  const runIdByTrigger = new Map<string, string>();
  for (const [runId, run] of runs) {
    if (run.inputTransportMessageId !== undefined) runIdByTrigger.set(run.inputTransportMessageId, runId);
  }
  const runIdOf = (message: ThreadMessage): string | undefined =>
    message.runId ?? runIdByTrigger.get(message.transportMessageId);

  // Hide messages that render nothing — a message holding only
  // function_call_output items, or only a tool-approval-request's state,
  // produces no parts (its content shows on the call's message), so it would
  // otherwise draw an empty bubble.
  const visibleMessages = messages.filter((message) => toDisplayParts(message, toolOutputs, toolStates).length > 0);

  // Runs whose output is visible carry their terminal error on their own
  // assistant bubble(s). A run that failed before producing any output has no
  // such bubble, so its error renders under the triggering user message
  // instead.
  const runsWithVisibleOutput = new Set(
    visibleMessages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => (message.runId === undefined ? [] : [message.runId])),
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
              oldest message, so it remains reachable mid-chat. */}
          <IntroCard
            scenarios={DEMO_SCENARIOS}
            title={INTRO_TITLE}
            description={INTRO_DESCRIPTION}
          />
          {loading && <LoadingHistory />}

          {visibleMessages.map((message) => {
            // Project the owning run into primitives at this glue layer so the
            // MessageBubble component stays a pure renderer with no transport
            // type dependencies.
            const runId = runIdOf(message);
            const run = runId === undefined ? undefined : runs.get(runId);
            // Translate the run lifecycle status to the bubble's rendering
            // vocabulary: `'active'` → `'streaming'`.
            const bubbleStatus = run?.status === 'active' ? 'streaming' : run?.status;
            // The run's terminal error, placed per the rule above: on the run's
            // assistant output when any is visible, else on the triggering user
            // bubble.
            const errorMessage =
              run?.status === 'error' &&
              runId !== undefined &&
              (message.role === 'assistant' || !runsWithVisibleOutput.has(runId))
                ? run.errorMessage
                : undefined;
            return (
              <MessageBubble
                key={message.transportMessageId}
                message={message}
                toolOutputs={toolOutputs}
                toolStates={toolStates}
                clientId={message.clientId}
                runId={runId}
                status={bubbleStatus}
                errorMessage={errorMessage}
                onApproveTool={(callId) => {
                  onApproveTool(message.transportMessageId, callId);
                }}
                onDenyTool={(callId) => {
                  onDenyTool(message.transportMessageId, callId);
                }}
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
