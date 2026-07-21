'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { OpenAITurn } from '@ably/ai-transport/openai';
import type { CodecMessage } from '@ably/ai-transport';
import type * as Ably from 'ably';

/** One transport lifecycle event observed on the session, for the debug pane. */
export interface CallbackLogEntry {
  /** When the event was recorded (ms since epoch). */
  time: number;
  /** Which lifecycle event this is. */
  type: 'runStart' | 'runSuspend' | 'runResume' | 'runEnd' | 'error';
  /** Human-readable one-line summary (ids, reason, error message). */
  summary: string;
}

interface DebugPaneProps {
  // The visible messages paired with their codec-message-ids; the pane renders
  // the raw `message` halves (turns) as JSON.
  messages: CodecMessage<OpenAITurn>[];
  ablyMessages: Ably.InboundMessage[];
  status: string;
  callbackLog: CallbackLogEntry[];
  statusLog: { time: number; status: string }[];
  onClearLogs: () => void;
}

type Tab = 'ably' | 'turns' | 'lifecycle';

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
      className="flex-1 overflow-y-auto p-3 space-y-3"
    >
      {entries.length === 0 && (
        <p className="text-xs text-zinc-700 text-center mt-8">Raw Ably messages will appear here.</p>
      )}
      {entries.map((entry, idx) => {
        const tiers = extractTiers(entry);
        return (
          <div
            key={idx}
            className="rounded border border-zinc-800 bg-zinc-900/50 p-2 text-[11px] font-mono"
          >
            <div className="flex items-center gap-2 text-zinc-500 mb-1">
              <span className="text-zinc-600">#{idx}</span>
              <span>{new Date(entry.timestamp ?? Date.now()).toLocaleTimeString()}</span>
              <span className="text-emerald-500">{entry.name ?? '(unnamed)'}</span>
              <span className="text-amber-500">{String(entry.action ?? 'message.create')}</span>
            </div>
            {AI_TIERS.map((tier) => {
              const tierHeaders = tiers[tier];
              if (Object.keys(tierHeaders).length === 0) return null;
              return (
                <div
                  key={tier}
                  className="ml-2 mb-1 space-y-0.5"
                >
                  <div className="text-zinc-700">extras.ai.{tier}</div>
                  {Object.entries(tierHeaders).map(([k, v]) => (
                    <div
                      key={k}
                      className="text-zinc-600 ml-2"
                    >
                      <span className="text-zinc-500">{k}</span>
                      <span className="text-zinc-700">: </span>
                      <span className="text-zinc-400">{v}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {entry.data !== undefined && entry.data !== null && (
              <div className="mt-1 text-zinc-600 break-all whitespace-pre-wrap">
                {typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TurnsTab({ turns, status }: { turns: OpenAITurn[]; status: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-3"
    >
      <div className="mb-3 flex gap-2">
        <div className="rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1.5 text-[10px]">
          <span className="text-zinc-600">Session status: </span>
          <span className={`font-mono ${status === 'running' ? 'text-emerald-400' : 'text-zinc-600'}`}>{status}</span>
        </div>
      </div>
      {turns.length === 0 ? (
        <p className="text-xs text-zinc-700 text-center mt-8">Conversation turns will appear here as JSON.</p>
      ) : (
        <pre className="text-[11px] leading-4 text-zinc-500 whitespace-pre-wrap break-all font-mono">
          {JSON.stringify(turns, null, 2)}
        </pre>
      )}
    </div>
  );
}

const callbackTypeColors: Record<string, string> = {
  runStart: 'text-blue-400',
  runSuspend: 'text-amber-400',
  runResume: 'text-cyan-400',
  runEnd: 'text-emerald-400',
  error: 'text-red-400',
};

const statusColors: Record<string, string> = {
  idle: 'text-zinc-500',
  running: 'text-emerald-400',
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
      className="flex-1 overflow-y-auto p-3 space-y-3"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-zinc-400 uppercase tracking-wider">Status transitions</span>
        <button
          onClick={onClear}
          className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          clear
        </button>
      </div>

      {statusLog.length === 0 ? (
        <p className="text-xs text-zinc-500 text-center">No status changes yet.</p>
      ) : (
        <div className="rounded border border-zinc-800 bg-zinc-900/50 p-2 text-[11px] font-mono flex flex-wrap gap-1 items-center">
          {statusLog.map((entry, idx) => (
            <span
              key={idx}
              className="flex items-center gap-1"
            >
              {idx > 0 && <span className="text-zinc-700">&rarr;</span>}
              <span className={statusColors[entry.status] ?? 'text-zinc-500'}>{entry.status}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 mb-2">
        <span className="text-[10px] text-zinc-400 uppercase tracking-wider">Run lifecycle</span>
      </div>

      {callbackLog.length === 0 ? (
        <p className="text-xs text-zinc-500 text-center">Run start, run end, and error events will appear here.</p>
      ) : (
        callbackLog.map((entry, idx) => (
          <div
            key={idx}
            className="rounded border border-zinc-800 bg-zinc-900/50 p-2 text-[11px] font-mono"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-zinc-400">{new Date(entry.time).toLocaleTimeString()}</span>
              <span className={callbackTypeColors[entry.type] ?? 'text-zinc-400'}>{entry.type}</span>
            </div>
            <div className="text-indigo-300 break-all whitespace-pre-wrap">{entry.summary}</div>
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

  // Project away the codec-message-id pairing — the pane renders raw turns.
  const turns = useMemo(() => messages.map((m) => m.message), [messages]);

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed right-0 top-1/2 -translate-y-1/2 rounded-l-md bg-zinc-800 border border-r-0 border-zinc-700 px-1.5 py-3 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Show debug pane"
        >
          &lsaquo;
        </button>
      )}

      {isOpen && (
        <div className="w-[420px] flex-shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950">
          <div className="flex h-16 flex-shrink-0 items-center justify-between border-b border-zinc-800 px-3">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setTab('ably')}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
                  tab === 'ably' ? 'bg-zinc-800 text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'
                }`}
              >
                Ably Messages
                <span className="ml-1 text-zinc-600">{ablyMessages.length}</span>
              </button>
              <button
                onClick={() => setTab('turns')}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
                  tab === 'turns' ? 'bg-zinc-800 text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'
                }`}
              >
                Turns
                <span className="ml-1 text-zinc-600">{messages.length}</span>
              </button>
              <button
                onClick={() => setTab('lifecycle')}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
                  tab === 'lifecycle' ? 'bg-zinc-800 text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'
                }`}
              >
                Lifecycle
                <span className="ml-1 text-zinc-600">{callbackLog.length}</span>
              </button>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              close
            </button>
          </div>
          {tab === 'ably' ? (
            <AblyMessagesTab entries={ablyMessages} />
          ) : tab === 'turns' ? (
            <TurnsTab
              turns={turns}
              status={status}
            />
          ) : (
            <LifecycleTab
              callbackLog={callbackLog}
              statusLog={statusLog}
              onClear={onClearLogs}
            />
          )}
        </div>
      )}
    </>
  );
}
