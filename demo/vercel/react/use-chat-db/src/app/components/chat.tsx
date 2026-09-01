'use client';

import { useChat } from '@ai-sdk/react';
import {
  isDynamicToolUIPart,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai';
import type { UIMessage } from 'ai';
import { useAblyMessages } from '@ably/ai-transport/react';
import type { ChatTransport } from '@ably/ai-transport/vercel/react';
import { useChatTransport } from '@ably/ai-transport/vercel/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Chat as ChatView,
  COMMON_SCENARIOS,
  hasClientTool,
  runClientTool,
  type CallbackLogEntry,
  type ClientToolLogEntry,
  type DemoStepId,
  type Scenario,
} from '@ably-ai-demos/frontend';
import { type ChatTransportEvent, mergeMessages } from '../lib/merge-messages';

// The scenarios this linear demo can drive: the shared baseline entries whose
// completion it can detect from a plain message list (server/client/approval
// tools and cancel), plus the intro-only Observability entry (no id). The
// branching scenarios (multi-tab, edit, regenerate) are excluded — this demo
// renders `useChat`'s linear messages with no branch navigation.
const DRIVEN_IDS = new Set<DemoStepId>(['server-weather', 'client-weather', 'approval-forecast', 'cancel']);
const SCENARIOS: readonly Scenario[] = COMMON_SCENARIOS.filter((s) => s.id === undefined || DRIVEN_IDS.has(s.id));

/** Tool-part states that need no further client action — the turn can persist. */
const TERMINAL_TOOL_STATES = new Set(['output-available', 'output-error', 'output-denied']);

/**
 * Whether an assistant message's turn is complete: every tool part is
 * resolved. A message carrying a pending client tool, an unanswered approval,
 * or an approved-but-unexecuted call is still waiting on this client, so it
 * is not persisted — the next load rebuilds it from the channel walk.
 * @param message - The assistant message useChat finished streaming.
 * @returns True when the turn can be persisted.
 */
const isTurnComplete = (message: UIMessage): boolean =>
  message.parts.every(
    (part) => (!isToolUIPart(part) && !isDynamicToolUIPart(part)) || TERMINAL_TOOL_STATES.has(part.state),
  );

/** Props for {@link Chat}. */
export interface ChatProps {
  /** The conversation id (the channel name); also `useChat`'s `id` and the store key. */
  chatId: string;
  /** This client's own clientId, shown in the header and avatar stack. */
  clientId?: string;
  /** The provider's useChat adapter, its history walk already run by the hydration hook. */
  chatTransport: ChatTransport;
  /** The hydrated conversation useChat initializes from: store seed + the channel walk. */
  initialMessages: UIMessage[];
  /** Whether channel history older than the hydrated window remains unpaged. */
  initialHasOlder: boolean;
}

/**
 * A linear chat driven exclusively by `useChat` over the SDK's chat transport:
 * every send publishes to the channel and the streamed reply arrives back
 * through the adapter's run stream. `useChat` initializes from the hydrated
 * conversation (the store plus the channel walk since its serial) and owns
 * the message list from then on; `resume: true` reconnects a run still
 * streaming from before a reload. Each completed turn is POSTed to the demo's message
 * store, which is what the next page load seeds from.
 *
 * The demo keeps the full tool surface: a server tool (getWeather), a
 * client-executed tool (getLocation), and
 * an approval-gated tool (getWeatherForecast).
 * @param props - The conversation id, this client's id, the adapter, and the hydrated state.
 */
export function Chat({ chatId, clientId, chatTransport, initialMessages, initialHasOlder }: ChatProps) {
  const { transport } = useChatTransport();
  const ablyMessages = useAblyMessages();

  // The newest channel serial this client has seen, persisted alongside each
  // turn so the next page load walks the channel back only that far.
  //
  // Written straight from the transport's own subscription rather than from
  // `useAblyMessages`: that hook goes through React state, which commits on a
  // later tick than the stream reader's microtask chain, so `onFinish` would
  // read a serial at least one delivery stale. The store's invariant is that
  // everything at or before the serial is accounted for, and a stale serial
  // makes the next walk re-merge a message the seed already holds.
  const latestSerialRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!transport) return;
    return transport.on('ably-message', (message) => {
      if (message.serial !== undefined) latestSerialRef.current = message.serial;
    });
  }, [transport]);

  // -- Callback & status logging for the debug pane -------------------------
  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
  const [clientToolLog, setClientToolLog] = useState<ClientToolLogEntry[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
    setClientToolLog([]);
  }, []);

  // Record client-side tool executions, keyed by toolCallId. Each onExecute
  // call carries a complete entry, so the `done` entry replaces the earlier
  // `executing` one in place.
  const recordClientTool = useCallback((entry: ClientToolLogEntry) => {
    setClientToolLog((prev) => {
      const idx = prev.findIndex((e) => e.toolCallId === entry.toolCallId);
      if (idx === -1) return [...prev, entry];
      const next = [...prev];
      next[idx] = entry;
      return next;
    });
  }, []);

  const { messages, setMessages, sendMessage, stop, status, error, addToolOutput, addToolApprovalResponse } = useChat({
    id: chatId,
    transport: chatTransport,
    messages: initialMessages,
    // Reconnect to a run that was still streaming when the page loaded.
    resume: true,
    // Auto-submit after addToolOutput resolves tool calls OR
    // addToolApprovalResponse resolves approvals, so the assistant continues
    // with the tool output / approved execution.
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages: msgs }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
    onToolCall: async ({ toolCall }) => {
      setCallbackLog((prev) => [
        ...prev,
        {
          time: Date.now(),
          type: 'onToolCall',
          summary: `${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
        },
      ]);
      if (!hasClientTool(toolCall.toolName)) return;
      const result = await runClientTool(toolCall.toolName, toolCall.toolCallId, toolCall.input, recordClientTool);
      // Not awaited inside onToolCall, per useChat's contract; the resolved
      // part then satisfies sendAutomaticallyWhen and the adapter publishes
      // the continuation.
      if ('output' in result) {
        void addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output: result.output });
      } else {
        void addToolOutput({
          state: 'output-error',
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          errorText: result.errorText,
        });
      }
    },
    onFinish: ({ message, messages: allMessages, isAbort, isError, finishReason }) => {
      setCallbackLog((prev) => [
        ...prev,
        {
          time: Date.now(),
          type: 'onFinish',
          summary: `reason=${String(finishReason)}, parts=${String(message.parts.length)}`,
        },
      ]);
      // Nothing is persisted while the latest turn is unfinished — waiting on
      // this client for a tool result or an approval, aborted, or errored. The
      // watermark would then name a serial the store cannot account for, and
      // the next walk would skip straight past that turn.
      if (isAbort || isError || !isTurnComplete(message)) return;

      // The whole conversation goes, not just this turn. The watermark's
      // contract is that every channel message at or before it is in the
      // store, and a turn-sized write cannot honour that: an earlier turn this
      // client skipped, a message another participant sent, or anything the
      // hydration walk recovered would all sit before the watermark and never
      // be written. The store upserts by domain id, so re-sending what it
      // already holds costs a map write.
      //
      // Fire-and-forget: the response body is not consumed and a failed write
      // only means the next reload re-reads the turns from channel history.
      void fetch('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: chatId,
          messages: allMessages,
          latestSerial: latestSerialRef.current,
        }),
      }).catch(() => undefined);
    },
    onError: (chatError) => {
      setCallbackLog((prev) => [
        ...prev,
        {
          time: Date.now(),
          type: 'onError',
          summary: chatError.message,
        },
      ]);
    },
  });

  // Track status transitions, annotating an error transition with the message
  // useChat exposes alongside the status. Recording a history of an external
  // value's transitions is the intended use of this effect.
  useEffect(() => {
    setStatusLog((prev) => [
      ...prev,
      { time: Date.now(), status: status === 'error' && error ? `error (${error.message})` : status },
    ]);
  }, [status, error]);

  // useChat's status reflects the in-flight request: 'submitted'/'streaming'
  // while a response is arriving, 'ready' when idle.
  const isRunning = status === 'submitted' || status === 'streaming';

  // -- Older history ---------------------------------------------------------
  // Hydration stops paging at the newest stored message; anything older on the
  // channel normally duplicates the store seed, so loading it prepends nothing
  // — the affordance surfaces the paging path, and would recover any message
  // the store lost. Batches accumulate so a stream spanning batch boundaries
  // remerges whole once its opener is paged in.
  const [hasOlder, setHasOlder] = useState(initialHasOlder);
  const olderEventsRef = useRef<ChatTransportEvent[]>([]);
  // One page at a time: the transport's history cursor is shared, so two
  // concurrent walks would each advance it and their prepends could interleave
  // out of order.
  const loadingOlderRef = useRef(false);
  const loadOlder = useCallback(() => {
    if (!transport || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    void (async () => {
      const batch = await transport.history();
      olderEventsRef.current = [...batch.events, ...olderEventsRef.current];
      const merged = await mergeMessages(olderEventsRef.current);
      setMessages((current) => {
        // Remerging the accumulated batches can improve a message already
        // prepended (its opener may only now have been paged in), so the
        // newer merge replaces by id rather than being filtered out.
        const remerged = new Map(merged.map((entry) => [entry.message.id, entry.message]));
        const kept = current.map((message) => remerged.get(message.id) ?? message);
        const currentIds = new Set(current.map((message) => message.id));
        const fresh = merged.map((entry) => entry.message).filter((message) => !currentIds.has(message.id));
        return fresh.length === 0 ? kept : [...fresh, ...kept];
      });
      if (batch.exhausted) setHasOlder(false);
    })()
      .catch(() => setHasOlder(false))
      .finally(() => {
        loadingOlderRef.current = false;
      });
  }, [transport, setMessages]);

  // Stop is two operations. `stop()` closes this client's stream; only
  // `chatTransport.cancel()` puts `ai-cancel` on the channel, which is what
  // aborts the agent and tells every other participant the run is over.
  const cancelRun = useCallback(async () => {
    await stop();
    await chatTransport.cancel();
  }, [stop, chatTransport]);

  const handleSend = useCallback(
    (text: string) => {
      // Linear history: a new turn cancels any still-streaming response first,
      // so the transcript only ever holds complete (or cancelled) runs.
      void (async () => {
        if (isRunning) await cancelRun();
        await sendMessage({ text });
      })();
    },
    [isRunning, cancelRun, sendMessage],
  );

  return (
    <ChatView
      chatId={chatId}
      clientId={clientId}
      headerTitle="Ably AI — useChat + database hydration"
      scenarios={SCENARIOS}
      messages={messages}
      isRunning={isRunning}
      onSend={handleSend}
      onStop={() => void cancelRun()}
      onToolApprove={(toolPart) => {
        const id = toolPart.approval?.id;
        if (id) void addToolApprovalResponse({ id, approved: true });
      }}
      onToolDeny={(toolPart) => {
        const id = toolPart.approval?.id;
        if (id) void addToolApprovalResponse({ id, approved: false, reason: 'User denied' });
      }}
      hasOlder={hasOlder}
      onLoadOlder={loadOlder}
      ablyMessages={ablyMessages}
      callbackLog={callbackLog}
      clientToolLog={clientToolLog}
      statusLog={statusLog}
      onClearLogs={clearLogs}
    />
  );
}
