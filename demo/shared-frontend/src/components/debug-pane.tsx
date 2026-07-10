'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { UIMessage } from 'ai';
import type { CodecMessage } from '@ably/ai-transport';
import type * as Ably from 'ably';
import { ChevronLeftIcon } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/**
 * One SDK callback observed since page load, rendered in the Lifecycle tab.
 *
 * `type` spans both consumer families this shared pane serves: the ClientSession
 * run-lifecycle callbacks (`runStart`/`runSuspend`/`runResume`/`runEnd`/`error`)
 * and the Vercel `useChat` callbacks (`onToolCall`/`onFinish`/`onData`/`onError`).
 * A container feeds only its own family's literals; the pane colours each and
 * falls back to a neutral colour for any it does not recognise.
 */
export interface CallbackLogEntry {
  /** When the callback fired (ms since epoch). */
  time: number;
  /** Which callback fired; selects the entry's colour in the Lifecycle tab. */
  type:
    | 'runStart'
    | 'runSuspend'
    | 'runResume'
    | 'runEnd'
    | 'error'
    | 'steerPublished'
    | 'steerOutcome'
    | 'steerRejected'
    | 'onToolCall'
    | 'onFinish'
    | 'onData'
    | 'onError';
  /** One-line, human-readable description of what the callback carried. */
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

/** Props for {@link DebugPane}. */
interface DebugPaneProps {
  /** Visible messages paired with codec-message-ids; the pane renders the raw `message` halves as JSON. */
  messages: CodecMessage<UIMessage>[];
  /** Raw inbound Ably messages, oldest first; rendered with their `extras.ai` header tiers. */
  ablyMessages: Ably.InboundMessage[];
  /** Current session or chat status string, shown in the UIMessages tab. */
  status: string;
  /** SDK callbacks observed since page load, oldest first. */
  callbackLog: CallbackLogEntry[];
  /** Status-transition history, oldest first. */
  statusLog: { time: number; status: string }[];
  /** Client-side tool executions observed on this client, keyed by `toolCallId`. */
  clientToolLog: ClientToolLogEntry[];
  /** Clears the callback, status, and tool logs. */
  onClearLogs: () => void;
  /** localStorage key persisting the pane's open/closed state; defaults to a shared demo key. */
  storageKey?: string;
}

type Tab = 'ably' | 'uimessages' | 'lifecycle';

// Default localStorage key for the pane's open/closed state. Stored as a string
// so an absent key (first visit) falls through to the default-open behaviour.
const DEFAULT_PANE_OPEN_STORAGE_KEY = 'ait-demo:debug-pane-open';

const AI_TIERS = ['transport', 'codec'] as const;

/**
 * Read the SDK's `extras.ai` namespace, preserving its two-tier structure:
 * `extras.ai.transport` (transport headers) and `extras.ai.codec` (codec
 * headers). Returns an empty record per tier when absent.
 */
function extractTiers(msg: Ably.InboundMessage): Record<(typeof AI_TIERS)[number], Record<string, string>> {
  // CAST: Ably types `extras` as `any`; narrow to the optional `ai` envelope
  // this pane reads. Every access is optional-chained, so a shape mismatch
  // yields empty tiers rather than throwing.
  const ai = (msg.extras as { ai?: { transport?: Record<string, string>; codec?: Record<string, string> } } | undefined)
    ?.ai;
  return { transport: ai?.transport ?? {}, codec: ai?.codec ?? {} };
}

// Colours for each callback type across both consumer families; an unrecognised
// type falls back to a neutral colour at the call site.
const callbackTypeColors: Record<string, string> = {
  // ClientSession run-lifecycle callbacks.
  runStart: 'text-blue-400',
  runSuspend: 'text-amber-400',
  runResume: 'text-cyan-400',
  runEnd: 'text-emerald-400',
  error: 'text-red-400',
  // Mid-run client steering (ClientSession).
  steerPublished: 'text-purple-400',
  steerOutcome: 'text-fuchsia-400',
  steerRejected: 'text-red-300',
  // Vercel useChat callbacks.
  onToolCall: 'text-blue-400',
  onFinish: 'text-emerald-400',
  onData: 'text-purple-400',
  onError: 'text-red-400',
};

// Colours for each status string across both consumer families; an unrecognised
// status falls back to the default badge colour.
const statusColors: Record<string, string> = {
  // ClientSession session status.
  idle: 'text-muted-foreground/80',
  running: 'text-emerald-400',
  // Vercel useChat status.
  ready: 'text-muted-foreground/80',
  submitted: 'text-amber-400',
  streaming: 'text-emerald-400',
  error: 'text-destructive',
};

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
            className="rounded-md border bg-card p-2 font-mono text-[11px]"
          >
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-muted-foreground/80">
              <span className="text-muted-foreground/60">#{idx}</span>
              <span>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</span>
              <Badge
                variant="secondary"
                className="text-emerald-500"
              >
                {entry.name ?? '(unnamed)'}
              </Badge>
              <Badge
                variant="outline"
                className="text-amber-500"
              >
                {String(entry.action ?? 'message.create')}
              </Badge>
            </div>
            {AI_TIERS.map((tier) => {
              const tierHeaders = tiers[tier];
              if (Object.keys(tierHeaders).length === 0) return null;
              return (
                <div
                  key={tier}
                  className="mb-1 ml-2 flex flex-col gap-0.5"
                >
                  <div className="text-muted-foreground/50">extras.ai.{tier}</div>
                  {Object.entries(tierHeaders).map(([k, v]) => (
                    <div
                      key={k}
                      className="ml-2 text-muted-foreground/60"
                    >
                      <span className="text-muted-foreground/80">{k}</span>
                      <span>: </span>
                      <span className="text-muted-foreground">{v}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {entry.data !== undefined && entry.data !== null && (
              <div className="mt-1 break-all whitespace-pre-wrap text-muted-foreground/60">
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
        <span className="text-[10px] text-muted-foreground">Status</span>
        <Badge
          variant="secondary"
          className={statusColors[status]}
        >
          {status}
        </Badge>
      </div>
      {messages.length === 0 ? (
        <p className="mt-8 text-center text-xs text-muted-foreground">Messages will appear here as JSON.</p>
      ) : (
        <pre className="font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted-foreground/80">
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
        <div className="flex flex-wrap items-center gap-1 rounded-md border bg-card p-2 font-mono text-[11px]">
          {statusLog.map((entry, idx) => (
            <span
              key={idx}
              className="flex items-center gap-1"
            >
              {idx > 0 && <span className="text-muted-foreground/50">→</span>}
              <span className={statusColors[entry.status] ?? 'text-muted-foreground/80'}>{entry.status}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-1">
        <span className="text-[10px] tracking-wider text-muted-foreground uppercase">Callbacks</span>
      </div>

      {callbackLog.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground">Callback events will appear here.</p>
      ) : (
        callbackLog.map((entry, idx) => (
          <div
            key={idx}
            className="rounded-md border bg-card p-2 font-mono text-[11px]"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-muted-foreground">{new Date(entry.time).toLocaleTimeString()}</span>
              <Badge
                variant={entry.type === 'error' || entry.type === 'onError' ? 'destructive' : 'secondary'}
                className={callbackTypeColors[entry.type] ?? 'text-muted-foreground'}
              >
                {entry.type}
              </Badge>
            </div>
            <div className="break-all whitespace-pre-wrap text-indigo-300">{entry.summary}</div>
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
            className="rounded-md border bg-card p-2 font-mono text-[11px]"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-muted-foreground">{new Date(entry.time).toLocaleTimeString()}</span>
              <span className="text-blue-400">{entry.toolName}</span>
              <Badge
                variant={entry.status === 'error' ? 'destructive' : 'secondary'}
                className={
                  entry.status === 'done' ? 'text-emerald-400' : entry.status === 'error' ? undefined : 'text-amber-400'
                }
              >
                {entry.status}
              </Badge>
            </div>
            <div className="break-all text-muted-foreground/60">id: {entry.toolCallId}</div>
            <div className="break-all whitespace-pre-wrap text-muted-foreground/80">
              in: {JSON.stringify(entry.input)}
            </div>
            {entry.status === 'done' && (
              <div className="break-all whitespace-pre-wrap text-indigo-300">out: {JSON.stringify(entry.output)}</div>
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
  storageKey = DEFAULT_PANE_OPEN_STORAGE_KEY,
}: DebugPaneProps) {
  // Restore the last open/closed choice. A lazy initialiser is safe here
  // because the pane only mounts client-side, after the Ably connection is
  // ready, so there is no server-rendered markup for this state to mismatch.
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem(storageKey) !== 'false';
  });

  // Persist on every change so the next refresh reopens in the same state.
  useEffect(() => {
    localStorage.setItem(storageKey, String(isOpen));
  }, [isOpen, storageKey]);

  // Project away the codec-message-id pairing — the pane renders raw messages.
  const uiMessages = useMemo(() => messages.map((m) => m.message), [messages]);
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
