'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { UIMessage } from 'ai';
import type { CodecMessage } from '@ably/ai-transport';
import type * as Ably from 'ably';
import { ChevronLeftIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface CallbackLogEntry {
  time: number;
  type: 'runStart' | 'runSuspend' | 'runResume' | 'runEnd' | 'error';
  summary: string;
}

/** Fields common to every {@link ClientToolLogEntry} variant. */
interface ClientToolLogEntryBase {
  /** When execution started (ms since epoch). */
  time: number;
  /** Tool name, e.g. `getLocation`. */
  toolName: string;
  /** AI SDK tool-call id; the upsert key, also shown for cross-referencing the Ably Messages tab. */
  toolCallId: string;
  /** The tool input the model produced. */
  input: unknown;
}

/**
 * One client-side tool execution observed on THIS client since page load.
 * Recorded locally by `useClientTools` at the moment the tool runs here, so it
 * attributes execution to this running instance — which the replicated
 * conversation state can't, since that looks identical in every participant.
 *
 * Discriminated on `status`: `output` exists only when `done`, `error` only
 * when `error`.
 */
export type ClientToolLogEntry =
  | (ClientToolLogEntryBase & {
      /** Execution has started; the executor has not yet settled. */
      status: 'executing';
    })
  | (ClientToolLogEntryBase & {
      /** Execution succeeded. */
      status: 'done';
      /** The executor's output. */
      output: unknown;
    })
  | (ClientToolLogEntryBase & {
      /** Execution threw. */
      status: 'error';
      /** The failure message. */
      error: string;
    });

interface DebugPaneProps {
  // The visible messages paired with their codec-message-ids; the pane renders
  // the raw `message` halves as JSON.
  messages: CodecMessage<UIMessage>[];
  ablyMessages: Ably.InboundMessage[];
  status: string;
  callbackLog: CallbackLogEntry[];
  statusLog: { time: number; status: string }[];
  clientToolLog: ClientToolLogEntry[];
  onClearLogs: () => void;
}

type Tab = 'ably' | 'uimessages' | 'lifecycle';

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
            className="rounded-md border border-border bg-muted/50 p-2 font-mono text-[11px]"
          >
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-muted-foreground">
              <span>#{idx}</span>
              <span>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</span>
              <Badge variant="secondary">{entry.name ?? '(unnamed)'}</Badge>
              <Badge variant="outline">{String(entry.action ?? 'message.create')}</Badge>
            </div>
            {AI_TIERS.map((tier) => {
              const tierHeaders = tiers[tier];
              if (Object.keys(tierHeaders).length === 0) return null;
              return (
                <div
                  key={tier}
                  className="mb-1 ml-2 flex flex-col gap-0.5"
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

function UIMessagesTab({ messages, status }: { messages: UIMessage[]; status: string }) {
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
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">Session status</span>
        <Badge variant="secondary">{status}</Badge>
      </div>
      {messages.length === 0 ? (
        <p className="mt-8 text-center text-xs text-muted-foreground">Messages will appear here as JSON.</p>
      ) : (
        <pre className="font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted-foreground">
          {JSON.stringify(messages, null, 2)}
        </pre>
      )}
    </div>
  );
}

function LifecycleTab({
  callbackLog,
  statusLog,
  clientToolLog,
  onClear,
}: {
  callbackLog: CallbackLogEntry[];
  statusLog: { time: number; status: string }[];
  clientToolLog: ClientToolLogEntry[];
  onClear: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [callbackLog, statusLog, clientToolLog]);

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
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/50 p-2 font-mono text-[11px]">
          {statusLog.map((entry, idx) => (
            <span
              key={idx}
              className="flex items-center gap-1"
            >
              {idx > 0 && <span className="text-muted-foreground">→</span>}
              <span className="text-foreground">{entry.status}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-1">
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
            className="rounded-md border border-border bg-muted/50 p-2 font-mono text-[11px]"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-muted-foreground">{new Date(entry.time).toLocaleTimeString()}</span>
              <Badge variant={entry.type === 'error' ? 'destructive' : 'secondary'}>{entry.type}</Badge>
            </div>
            <div className="break-all whitespace-pre-wrap text-foreground">{entry.summary}</div>
          </div>
        ))
      )}

      <div className="mt-1">
        <span className="text-[10px] tracking-wider text-muted-foreground uppercase">Client-side tool calls</span>
      </div>

      {clientToolLog.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          Tools this client executes (e.g. getLocation) will appear here.
        </p>
      ) : (
        clientToolLog.map((entry) => (
          <div
            key={entry.toolCallId}
            className="rounded-md border border-border bg-muted/50 p-2 font-mono text-[11px]"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-muted-foreground">{new Date(entry.time).toLocaleTimeString()}</span>
              <span className="text-foreground">{entry.toolName}</span>
              <Badge variant={entry.status === 'error' ? 'destructive' : 'secondary'}>{entry.status}</Badge>
            </div>
            <div className="break-all text-muted-foreground">id: {entry.toolCallId}</div>
            <div className="break-all whitespace-pre-wrap text-muted-foreground">in: {JSON.stringify(entry.input)}</div>
            {entry.status === 'done' && (
              <div className="break-all whitespace-pre-wrap text-foreground">out: {JSON.stringify(entry.output)}</div>
            )}
            {entry.status === 'error' && (
              <div className="break-all whitespace-pre-wrap text-destructive">err: {entry.error}</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export function DebugPane({
  messages,
  ablyMessages,
  status,
  callbackLog,
  statusLog,
  clientToolLog,
  onClearLogs,
}: DebugPaneProps) {
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

  // Project away the codec-message-id pairing — the pane renders raw messages.
  const uiMessages = useMemo(() => messages.map((m) => m.message), [messages]);
  const [tab, setTab] = useState<Tab>('ably');

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        className="fixed top-1/2 right-0 h-auto -translate-y-1/2 rounded-r-none rounded-l-md border-r-0 px-1.5 py-3"
        title="Show debug pane"
        aria-label="Show debug pane"
      >
        <ChevronLeftIcon />
      </Button>
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
          <TabsTrigger value="uimessages">
            UIMessages
            <span className="ml-1 text-muted-foreground">{messages.length}</span>
          </TabsTrigger>
          <TabsTrigger value="lifecycle">
            Lifecycle
            <span className="ml-1 text-muted-foreground">{callbackLog.length + clientToolLog.length}</span>
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
        value="uimessages"
        className="flex min-h-0 flex-1 flex-col"
      >
        <UIMessagesTab
          messages={uiMessages}
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
          clientToolLog={clientToolLog}
          onClear={onClearLogs}
        />
      </TabsContent>
    </Tabs>
  );
}
