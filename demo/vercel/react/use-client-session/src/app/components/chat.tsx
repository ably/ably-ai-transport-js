'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientRun } from '@ably/ai-transport';
import type { UIMessage } from 'ai';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

import { ArrowUpIcon, ExternalLinkIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { userMessage, wakeAgent } from '../helpers';
import { useClientTools } from '../hooks/use-client-tools';
import { useDemoProgress } from '../hooks/use-demo-progress';
import { MessageList } from './message-list';
import { SuggestionChips } from './suggestion-chips';
import type { CallbackLogEntry, ClientToolLogEntry } from './debug-pane';
import { DebugPane } from './debug-pane';
import { ChecklistWidget } from './checklist-widget';
import { SessionHooks } from '../providers';
import { clientColor } from '../lib/client-color';
import { AvatarStack } from './avatar-stack';

const { useClientSession, useView, useAblyMessages } = SessionHooks;

interface ChatProps {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
  /** Agent endpoint the demo POSTs invocations to, to wake the serverless agent. */
  api: string;
}

export function Chat({ chatId, clientId, historyLimit, api }: ChatProps) {
  const { session } = useClientSession();

  const [callbackLog, setCallbackLog] = useState<CallbackLogEntry[]>([]);
  const [statusLog, setStatusLog] = useState<{ time: number; status: string }[]>([]);
  const [clientToolLog, setClientToolLog] = useState<ClientToolLogEntry[]>([]);
  const clearLogs = useCallback(() => {
    setCallbackLog([]);
    setStatusLog([]);
    setClientToolLog([]);
  }, []);

  // Record client-side tool executions, keyed by toolCallId. Each onExecute
  // call carries a complete entry, so the `done`/`error` entry replaces the
  // earlier `executing` one in place.
  const recordClientTool = useCallback((entry: ClientToolLogEntry) => {
    setClientToolLog((prev) => {
      const idx = prev.findIndex((e) => e.toolCallId === entry.toolCallId);
      if (idx === -1) return [...prev, entry];
      const next = [...prev];
      next[idx] = entry;
      return next;
    });
  }, []);

  const view = useView({ limit: historyLimit ?? 30 });
  const { messages, hasOlder, loading, loadOlder, branchSelection, runOf } = view;

  useClientTools(view, clientId, api, recordClientTool);

  // Wake the agent for a freshly-sent run by POSTing its invocation pointer.
  // The core session never sends HTTP — the app owns the trigger. Send sites
  // pass the `view.send*` promise; a POST failure is surfaced in the log.
  const wake = useCallback(
    (runPromise: Promise<ClientRun<UIMessage>>) => {
      void runPromise
        .then((run) => wakeAgent(api, run))
        .catch((error: unknown) => {
          setCallbackLog((prev) => [
            ...prev,
            {
              time: Date.now(),
              type: 'error',
              summary: error instanceof Error ? error.message : 'failed to wake agent',
            },
          ]);
        });
    },
    [api],
  );

  // Derive "is a run in progress?" from the latest visible message's owning
  // Run status. Stop is shown ONLY while the run is actively streaming
  // ('active'). A 'suspended' run is paused awaiting input - a client tool
  // result, or a tool-approval decision - so there is no live stream to abort:
  // the user proceeds via the approval card, and the bar shows Send. This
  // mirrors the useChat demo, where Stop shows only for status
  // 'submitted' | 'streaming'. Terminal statuses ('complete' | 'cancelled' |
  // 'error') also show Send. The Run carries the runId Stop needs to cancel.
  const latestRun = runOf(messages.at(-1)?.codecMessageId ?? '');
  const latestRunId = latestRun?.runId;
  const latestStatus = latestRun?.status;
  const isRunInProgress = latestRunId !== undefined && latestStatus === 'active';
  const status = isRunInProgress ? 'running' : 'idle';

  // Track status transitions. Recording a history of an external value's
  // transitions is the intended use of this effect — it observes the derived
  // session status, it does not derive render state.
  useEffect(() => {
    setStatusLog((prev) => [...prev, { time: Date.now(), status }]);
  }, [status]);

  useEffect(() => {
    const offRun = session.tree.on('run', (event) => {
      const head = `runId=${event.runId.slice(0, 8)}, clientId=${event.clientId}`;
      let type: CallbackLogEntry['type'];
      let summary: string;
      if (event.type === 'start') {
        type = 'runStart';
        summary = head;
      } else if (event.type === 'suspend') {
        type = 'runSuspend';
        summary = head;
      } else if (event.type === 'resume') {
        type = 'runResume';
        summary = head;
      } else {
        type = 'runEnd';
        summary = `${head}, reason=${event.reason}`;
      }
      setCallbackLog((prev) => [
        ...prev,
        {
          time: Date.now(),
          type,
          summary,
        },
      ]);
    });
    const offErr = session.on('error', (error) => {
      setCallbackLog((prev) => [...prev, { time: Date.now(), type: 'error', summary: error.message }]);
    });
    return () => {
      offRun();
      offErr();
    };
  }, [session]);

  const ablyMessages = useAblyMessages();

  const unfinishedSteps = useDemoProgress(messages, branchSelection, runOf, ablyMessages);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  const handleToolApprove = useCallback(
    (codecMessageId: string, toolCallId: string) => {
      const run = view.runOf(codecMessageId);
      if (!run) return;
      wake(
        view.send([UIMessageCodec.createToolApprovalResponse(codecMessageId, { toolCallId, approved: true })], {
          runId: run.runId,
        }),
      );
    },
    [view, wake],
  );

  const handleToolDeny = useCallback(
    (codecMessageId: string, toolCallId: string) => {
      const run = view.runOf(codecMessageId);
      if (!run) return;
      wake(
        view.send(
          [
            UIMessageCodec.createToolApprovalResponse(codecMessageId, {
              toolCallId,
              approved: false,
              reason: 'User denied',
            }),
          ],
          { runId: run.runId },
        ),
      );
    },
    [view, wake],
  );

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header
          clientId={clientId}
          channelName={chatId}
        />
        <MessageList
          messages={messages}
          hasOlder={hasOlder}
          loading={loading}
          view={{
            branchSelection,
            runOf,
          }}
          onLoadOlder={() => void loadOlder()}
          onRegenerate={(codecMessageId) => wake(view.regenerate(codecMessageId))}
          onEdit={(codecMessageId, text) =>
            wake(view.edit(codecMessageId, [UIMessageCodec.createUserMessage(userMessage(text))]))
          }
          onToolApprove={handleToolApprove}
          onToolDeny={handleToolDeny}
        />
        <div className="border-t border-border">
          <SuggestionChips
            steps={unfinishedSteps}
            onSelectPrompt={handleSelectPrompt}
          />
          <InputBar
            value={input}
            onChange={setInput}
            inputRef={inputRef}
            onSend={(text) => wake(view.send(UIMessageCodec.createUserMessage(userMessage(text))))}
            onStop={() => {
              if (!latestRunId) return;
              // Stop only shows for an ACTIVE run, so a live agent is attached:
              // publishing the cancel signal makes it abort and publish run-end,
              // which flips the run to a terminal status and reverts Stop to Send.
              void session.cancel(latestRunId);
            }}
            hasAnyRuns={isRunInProgress}
          />
        </div>
      </div>
      <DebugPane
        messages={messages}
        ablyMessages={ablyMessages}
        status={status}
        callbackLog={callbackLog}
        statusLog={statusLog}
        clientToolLog={clientToolLog}
        onClearLogs={clearLogs}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ clientId, channelName }: { clientId?: string; channelName: string }) {
  return (
    <header className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {/* Liveness indicator — no semantic "online" token exists, so a
              fixed status colour is intentional here. */}
          <div className="size-2 rounded-full bg-emerald-500" />
          <h1 className="text-sm font-medium text-foreground">Ably AI — ClientSession</h1>
        </div>
        <div className="flex items-center gap-2 pl-4">
          <Button
            asChild
            variant="outline"
            size="xs"
            className="rounded-full"
          >
            <a
              href="https://github.com/ably/ably-ai-transport-js"
              target="_blank"
              rel="noreferrer"
            >
              SDK repo
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </Button>
          <Button
            asChild
            variant="outline"
            size="xs"
            className="rounded-full"
          >
            <a
              href="https://ably.com/docs/ai-transport"
              target="_blank"
              rel="noreferrer"
            >
              Ably docs
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </Button>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <AvatarStack
          channelName={channelName}
          selfClientId={clientId}
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.delete('clientId');
            window.open(url.toString(), '_blank');
          }}
          title="Open this channel in a new tab as a fresh client"
        >
          open in new tab
        </Button>
        {clientId && <span className={`font-mono text-xs ${clientColor(clientId).text}`}>{clientId}</span>}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Input bar — single Stop button when streaming, Send button otherwise
// ---------------------------------------------------------------------------

function InputBar({
  value,
  onChange,
  inputRef,
  onSend,
  onStop,
  hasAnyRuns,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string) => void;
  onStop: () => void;
  hasAnyRuns: boolean;
}) {
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onChange('');
    onSend(text);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="px-4 py-3"
    >
      <InputGroup>
        <InputGroupTextarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type a message..."
          autoFocus
          // Enter sends; Shift+Enter inserts a newline (standard composer UX).
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <InputGroupAddon align="block-end">
          {hasAnyRuns ? (
            <InputGroupButton
              type="button"
              variant="destructive"
              size="icon-sm"
              className="ml-auto rounded-full"
              aria-label="Stop"
              onClick={onStop}
            >
              <SquareIcon className="fill-current" />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-sm"
              className="ml-auto rounded-full"
              aria-label="Send"
              disabled={!value.trim()}
            >
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
