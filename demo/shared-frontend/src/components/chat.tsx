'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type * as Ably from 'ably';
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';

import { useDemoProgress } from '../hooks/use-demo-progress';
import type { Scenario } from '../lib/progress-steps';
import { LinearMessageList } from './message-list';
import type { MessageStatus } from './message-bubble';
import type { CallbackLogEntry, ClientToolLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import { COMMON_SCENARIOS } from './intro-card';
import { ChatShell, type HeaderLink } from './chat-shell';

interface ChatProps {
  /** Ably channel name the conversation lives on (shown in the header). */
  chatId: string;
  /** This client's id (tinted in the header). */
  clientId?: string;
  /** Header heading. Defaults to "Ably AI Transport". */
  headerTitle?: string;
  /** Header links. Defaults to the SDK repo + Ably docs. */
  headerLinks?: readonly HeaderLink[];
  /**
   * The scenarios this demo demonstrates — the single source for the intro-card
   * walkthrough and the suggestion chips. Defaults to the shared baseline.
   */
  scenarios?: readonly Scenario[];
  /** Intro-card heading. Defaults to the generic heading. */
  introTitle?: string;
  /** Intro-card blurb. Defaults to the generic blurb. */
  introDescription?: string;
  /**
   * Optional slot rendered between the message list and the input bar — the
   * anchor for a demo-specific widget (e.g. a LiveObjects checklist widget).
   */
  extraSlot?: ReactNode;
  /** The conversation to render (e.g. useChat's `messages`). */
  messages: UIMessage[];
  /**
   * Whether a run is in flight. Drives the Send/Stop toggle, the streaming
   * status on the last assistant message, and the status log.
   */
  isRunning: boolean;
  /** Send the composed text as a new user turn. */
  onSend: (text: string) => void;
  /** Stop the in-flight run. The Stop button is a no-op when omitted. */
  onStop?: () => void;
  /**
   * Steer the active run with a follow-up user message. When set, `/steer
   * <text>` in the composer routes here; when omitted, the full `/steer ...`
   * text passes through `onSend` as a normal send.
   */
  onSteer?: (text: string) => void;
  /** Approve a pending tool call; receives the tool part. */
  onToolApprove?: (toolPart: ToolUIPart | DynamicToolUIPart) => void;
  /** Deny a pending tool call; receives the tool part. */
  onToolDeny?: (toolPart: ToolUIPart | DynamicToolUIPart) => void;
  /** Whether an older history page is available; threaded to the transcript. */
  hasOlder?: boolean;
  /** Request the next older history page; threaded to the transcript. */
  onLoadOlder?: () => void;
  /** Raw inbound Ably messages — feeds the debug pane and progress detection. */
  ablyMessages: Ably.InboundMessage[];
  /** SDK/useChat callbacks observed since page load, owned by the demo. */
  callbackLog: CallbackLogEntry[];
  /** Client-side tool executions observed on this client, owned by the demo. */
  clientToolLog: ClientToolLogEntry[];
  /**
   * Status-transition history for the debug pane. When omitted, Chat derives
   * one internally from `isRunning` (idle/running transitions).
   */
  statusLog?: { time: number; status: string }[];
  /** Clears the demo-owned logs (and any internally derived status log). */
  onClearLogs: () => void;
}

/**
 * The shared presentational chat container: header, linear transcript,
 * suggestion chips, composer, and debug pane. It owns no transport or chat
 * state — the demo supplies `messages`, `isRunning`, the raw Ably messages,
 * and the action callbacks (typically wired from useChat and a transport).
 */
export function Chat({
  chatId,
  clientId,
  headerTitle = 'Ably AI Transport',
  headerLinks,
  scenarios = COMMON_SCENARIOS,
  introTitle,
  introDescription,
  extraSlot,
  messages,
  isRunning,
  onSend,
  onStop,
  onSteer,
  onToolApprove,
  onToolDeny,
  hasOlder,
  onLoadOlder,
  ablyMessages,
  callbackLog,
  clientToolLog,
  statusLog,
  onClearLogs,
}: ChatProps) {
  const status = isRunning ? 'running' : 'idle';

  // Fallback status-transition history, derived from isRunning, used when the
  // demo does not supply its own statusLog.
  const [derivedStatusLog, setDerivedStatusLog] = useState<{ time: number; status: string }[]>([]);
  useEffect(() => {
    setDerivedStatusLog((prev) => [...prev, { time: Date.now(), status }]);
  }, [status]);

  const handleClearLogs = useCallback(() => {
    setDerivedStatusLog([]);
    onClearLogs();
  }, [onClearLogs]);

  const unfinishedScenarios = useDemoProgress(scenarios, messages, ablyMessages);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Snap-to-live-edge callback published by the transcript; sending always
  // jumps to the bottom so the new turn and its streamed reply are in view.
  const scrollToEndRef = useRef<(() => void) | null>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  // The last assistant message streams while a run is in flight; everything
  // else renders with no live status.
  const statusOf = useCallback(
    (message: UIMessage, index: number): MessageStatus | undefined =>
      isRunning && index === messages.length - 1 && message.role === 'assistant' ? 'streaming' : undefined,
    [isRunning, messages.length],
  );

  const handleSend = useCallback(
    (text: string) => {
      // `/steer <text>` targets the active run when the demo wires onSteer —
      // a follow-up user message inside the running turn rather than a fresh
      // send. Without onSteer the text passes through as a normal send.
      const steerMatch = /^\/steer\s+(.+)$/.exec(text);
      if (steerMatch && onSteer) {
        onSteer(steerMatch[1]?.trim() ?? '');
        return;
      }
      scrollToEndRef.current?.();
      onSend(text);
    },
    [onSend, onSteer],
  );

  return (
    <ChatShell
      title={headerTitle}
      links={headerLinks}
      channelName={chatId}
      clientId={clientId}
      suggestions={unfinishedScenarios}
      onSelectPrompt={handleSelectPrompt}
      input={input}
      onInputChange={setInput}
      inputRef={inputRef}
      inputPlaceholder={onSteer ? 'Type a message... — or /steer <text> to steer the active run' : undefined}
      onSend={handleSend}
      onStop={() => onStop?.()}
      isRunning={isRunning}
      extraSlot={extraSlot}
      transcript={
        <LinearMessageList
          messages={messages}
          statusOf={statusOf}
          onToolApprove={onToolApprove}
          onToolDeny={onToolDeny}
          hasOlder={hasOlder}
          onLoadOlder={onLoadOlder}
          scrollToEndRef={scrollToEndRef}
          scenarios={scenarios}
          introTitle={introTitle}
          introDescription={introDescription}
        />
      }
      debugPane={
        <DebugPane
          messages={messages}
          ablyMessages={ablyMessages}
          status={status}
          callbackLog={callbackLog}
          statusLog={statusLog ?? derivedStatusLog}
          clientToolLog={clientToolLog}
          onClearLogs={handleClearLogs}
        />
      }
    />
  );
}
