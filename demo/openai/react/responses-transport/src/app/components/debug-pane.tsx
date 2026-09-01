'use client';

import { useState, useRef, useEffect } from 'react';
import type * as Ably from 'ably';
import { ChevronLeftIcon } from 'lucide-react';
import { Button } from '@ably-ai-demos/frontend/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ably-ai-demos/frontend/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ably-ai-demos/frontend/components/ui/tooltip';

import type { ThreadMessage } from '../lib/fold-thread';

/** One transport lifecycle event observed on the channel, for the debug pane. */
export interface CallbackLogEntry {
  /** When the event was recorded (ms since epoch). */
  time: number;
  /** Which lifecycle event this is. */
  type: 'runStart' | 'runSuspend' | 'runResume' | 'runEnd' | 'clientTool' | 'error';
  /** Human-readable one-line summary (ids, reason, error message). */
  summary: string;
}

interface DebugPaneProps {
  // The folded thread; the pane renders each message (its wire identity, run,
  // items, and tool-call state) as JSON.
  messages: ThreadMessage[];
  ablyMessages: Ably.InboundMessage[];
  status: string;
  callbackLog: CallbackLogEntry[];
  statusLog: { time: number; status: string }[];
  onClearLogs: () => void;
}

type Tab = 'ably' | 'messages' | 'lifecycle';

// Persist the pane's open/closed state across refreshes. Stored as a string so
// an absent key (first visit) falls through to the default-open behaviour.
const PANE_OPEN_STORAGE_KEY = 'ait-demo:debug-pane-open';

const AI_TIERS = ['transport', 'codec'] as const;

/**
 * Read the SDK's `extras.ai` namespace, preserving its two-tier structure:
 * `extras.ai.transport` (transport headers) and `extras.ai.codec` (codec
 * headers). Returns an empty record per tier when absent.
 */
function extractTiers(msg: Ably.InboundMessage): Record<(typeof AI_TIERS)[number], Record<string, string>> {
  // CAST: Ably types `Message.extras` as `any`; trust the SDK's `extras.ai`
  // two-tier shape and read it through the narrowest type, defaulting per tier.
  const ai = (msg.extras as { ai?: { transport?: Record<string, string>; codec?: Record<string, string> } } | undefined)
    ?.ai;
  return { transport: ai?.transport ?? {}, codec: ai?.codec ?? {} };
}

function AblyMessagesTab({ entries }: { entries: Ably.InboundMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div
      ref={scrollRef}
      className="flex flex-1 flex-col gap-3 overflow-y-auto p-3"
    >
      {entries.length === 0 && (
        <p className="mt-8 text-center text-xs text-muted-foreground">Raw Ably messages will appear here.</p>
      )}
      {entries.map((entry, idx) => {
        const tiers = extractTiers(entry);
        return (
          <div
            key={idx}
            className="rounded border bg-muted/50 p-2 font-mono text-[11px]"
          >
            <div className="mb-1 flex items-center gap-2 text-muted-foreground">
              <span>#{idx}</span>
              <span>{entry.timestamp === undefined ? '—' : new Date(entry.timestamp).toLocaleTimeString()}</span>
              <span className="text-emerald-500">{entry.name ?? '(unnamed)'}</span>
              <span className="text-amber-500">{String(entry.action ?? 'message.create')}</span>
            </div>
            {AI_TIERS.map((tier) => {
              const tierHeaders = tiers[tier];
              if (Object.keys(tierHeaders).length === 0) return null;
              return (
                <div
                  key={tier}
                  className="mb-1 ml-2 space-y-0.5"
                >
                  <div className="text-muted-foreground">extras.ai.{tier}</div>
                  {Object.entries(tierHeaders).map(([k, v]) => (
                    <div
                      key={k}
                      className="ml-2 text-muted-foreground"
                    >
                      <span>{k}</span>
                      <span>: </span>
                      <span className="text-foreground">{v}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {entry.data !== undefined && entry.data !== null && (
              <div className="mt-1 break-all whitespace-pre-wrap text-muted-foreground">
                {typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MessagesTab({ messages, status }: { messages: ThreadMessage[]; status: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-3"
    >
      <div className="mb-3 flex gap-2">
        <div className="rounded border bg-muted/50 px-2 py-1.5 text-[10px]">
          <span className="text-muted-foreground">Run status: </span>
          <span className={`font-mono ${status === 'running' ? 'text-emerald-500' : 'text-muted-foreground'}`}>
            {status}
          </span>
        </div>
      </div>
      {messages.length === 0 ? (
        <p className="mt-8 text-center text-xs text-muted-foreground">
          Conversation messages will appear here as JSON.
        </p>
      ) : (
        <pre className="font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted-foreground">
          {JSON.stringify(messages, null, 2)}
        </pre>
      )}
    </div>
  );
}

const callbackTypeColors: Record<string, string> = {
  runStart: 'text-blue-500',
  runSuspend: 'text-amber-500',
  runResume: 'text-cyan-500',
  runEnd: 'text-emerald-500',
  clientTool: 'text-violet-500',
  error: 'text-destructive',
};

const statusColors: Record<string, string> = {
  idle: 'text-muted-foreground',
  running: 'text-emerald-500',
};

function LifecycleTab({
  callbackLog,
  statusLog,
  onClear,
}: {
  callbackLog: CallbackLogEntry[];
  statusLog: { time: number; status: string }[];
  onClear: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [callbackLog, statusLog]);

  return (
    <div
      ref={scrollRef}
      className="flex flex-1 flex-col gap-3 overflow-y-auto p-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] tracking-wider text-muted-foreground uppercase">Status transitions</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={onClear}
          className="text-muted-foreground"
        >
          clear
        </Button>
      </div>

      {statusLog.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground">No status changes yet.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1 rounded border bg-muted/50 p-2 font-mono text-[11px]">
          {statusLog.map((entry, idx) => (
            <span
              key={idx}
              className="flex items-center gap-1"
            >
              {idx > 0 && <span className="text-muted-foreground">&rarr;</span>}
              <span className={statusColors[entry.status] ?? 'text-muted-foreground'}>{entry.status}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-4">
        <span className="text-[10px] tracking-wider text-muted-foreground uppercase">Run lifecycle</span>
      </div>

      {callbackLog.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          Run start, run end, and error events will appear here.
        </p>
      ) : (
        callbackLog.map((entry, idx) => (
          <div
            key={idx}
            className="rounded border bg-muted/50 p-2 font-mono text-[11px]"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-muted-foreground">{new Date(entry.time).toLocaleTimeString()}</span>
              <span className={callbackTypeColors[entry.type] ?? 'text-muted-foreground'}>{entry.type}</span>
            </div>
            <div className="break-all whitespace-pre-wrap text-foreground">{entry.summary}</div>
          </div>
        ))
      )}
    </div>
  );
}

export function DebugPane({ messages, ablyMessages, status, callbackLog, statusLog, onClearLogs }: DebugPaneProps) {
  // Restore the last open/closed choice. A lazy initialiser is safe here
  // because the pane only mounts client-side, after the Ably connection is
  // ready, so there is no server-rendered markup for this state to mismatch.
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem(PANE_OPEN_STORAGE_KEY) !== 'false';
  });

  // Persist on every change so the next refresh reopens in the same state.
  useEffect(() => {
    localStorage.setItem(PANE_OPEN_STORAGE_KEY, String(isOpen));
  }, [isOpen]);

  const [tab, setTab] = useState<Tab>('ably');

  if (!isOpen) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsOpen(true)}
            className="fixed top-1/2 right-0 h-auto -translate-y-1/2 rounded-r-none rounded-l-md border-r-0 px-1.5 py-3"
            aria-label="Show debug pane"
          >
            <ChevronLeftIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Show debug pane</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tabs
      value={tab}
      // CAST: Radix Tabs widens its onValueChange arg to string; the only
      // values wired up are the three TabsTrigger values, which are exactly Tab.
      onValueChange={(value) => setTab(value as Tab)}
      className="flex w-[420px] shrink-0 flex-col gap-0 border-l border-border bg-background"
    >
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-3">
        <TabsList>
          <TabsTrigger value="ably">
            Ably Messages
            <span className="ml-1 text-muted-foreground">{ablyMessages.length}</span>
          </TabsTrigger>
          <TabsTrigger value="messages">
            Messages
            <span className="ml-1 text-muted-foreground">{messages.length}</span>
          </TabsTrigger>
          <TabsTrigger value="lifecycle">
            Lifecycle
            <span className="ml-1 text-muted-foreground">{callbackLog.length}</span>
          </TabsTrigger>
        </TabsList>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsOpen(false)}
          className="text-muted-foreground"
        >
          close
        </Button>
      </div>
      <TabsContent
        value="ably"
        className="flex min-h-0 flex-1 flex-col"
      >
        <AblyMessagesTab entries={ablyMessages} />
      </TabsContent>
      <TabsContent
        value="messages"
        className="flex min-h-0 flex-1 flex-col"
      >
        <MessagesTab
          messages={messages}
          status={status}
        />
      </TabsContent>
      <TabsContent
        value="lifecycle"
        className="flex min-h-0 flex-1 flex-col"
      >
        <LifecycleTab
          callbackLog={callbackLog}
          statusLog={statusLog}
          onClear={onClearLogs}
        />
      </TabsContent>
    </Tabs>
  );
}
