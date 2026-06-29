'use client';

import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { useMessagesWithSeed } from '@ably/ai-transport/vercel/react';
import type { RunStatus } from '@ably/ai-transport';
import type { UIMessage } from 'ai';
import { useEffect, useState } from 'react';

import { userMessage, wakeAgent } from '../helpers';
import { SessionHooks } from '../providers';

const { useClientSession } = SessionHooks;

// Concatenate a message's text parts for a plain linear render.
function messageText(message: UIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

// Map a run's status to a response-state label shown on its assistant message.
function stateLabel(status: RunStatus | undefined): string {
  switch (status) {
    case 'active':
      return 'streaming';
    case 'suspended':
      return 'suspended';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'completed';
  }
}

/** Props for {@link SeededChat}. */
export interface SeededChatProps {
  /** The conversation id (the channel name) — rendered in the header. */
  chatId: string;
  /** The persisted conversation loaded from the database, used to seed the view. */
  seed: UIMessage[];
  /** Agent endpoint the demo POSTs invocations to, to wake the serverless agent. */
  api: string;
}

/**
 * A deliberately minimal, linear chat for the use-client-session
 * database-hydration demo. It seeds from the database and reconciles with the
 * live channel via the SDK's `useMessagesWithSeed` (the seam walk), then renders
 * the composed conversation and sends new turns over the session view. The agent
 * persists every completed turn back to the store.
 *
 * It is intentionally simple (text turns, no branch navigation or tool flows):
 * the seam composition is the showcase here. For the full branching UI and tool
 * flows see the sibling `use-client-session` demo. The seam walk is the sole
 * pager of the view, the precondition the single-overlap compose relies on.
 * @param props - The conversation id, the database seed, and the agent endpoint.
 */
export function SeededChat({ chatId, seed, api }: SeededChatProps): React.ReactElement {
  const { session } = useClientSession();
  const view = session.view;
  const messages = useMessagesWithSeed({ view, seed });

  // Track the latest run so the last assistant response can show its live state
  // (streaming → completed) and the composer can offer Stop while it streams.
  // The status transitions (run-start → run-end) arrive on the view's 'run'
  // event, not 'update' (which carries streamed content) — subscribe to both so
  // the response settles out of 'streaming' when the run ends.
  const [latestRun, setLatestRun] = useState<{ runId: string; status: RunStatus } | undefined>();
  useEffect(() => {
    const sync = (): void => {
      const run = view.runs().at(-1);
      setLatestRun(run ? { runId: run.runId, status: run.status } : undefined);
    };
    sync();
    const offUpdate = view.on('update', sync);
    const offRun = view.on('run', sync);
    return () => {
      offUpdate();
      offRun();
    };
  }, [view]);

  const streaming = latestRun?.status === 'active';
  const responseState = (message: UIMessage, index: number): string | undefined => {
    if (message.role !== 'assistant') return undefined;
    // The latest run's status applies to the last assistant message; earlier
    // assistant messages are from terminal runs and are complete.
    return index === messages.length - 1 ? stateLabel(latestRun?.status) : 'completed';
  };

  const [input, setInput] = useState('');

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    // Linear history: cancel any still-active response before starting a new
    // turn, so the seam reconciliation only ever meets complete (or cancelled)
    // turns. Then send over the session view and wake the agent to stream the
    // reply (which it persists to the store). Failures surface via
    // session.on('error').
    void (async () => {
      try {
        if (latestRun?.status === 'active') await session.cancel(latestRun.runId);
        const run = await session.view.send(UIMessageCodec.createUserMessage(userMessage(text)));
        await wakeAgent(api, run);
      } catch {
        // surfaced via session.on('error')
      }
    })();
  };

  return (
    <div className="mx-auto flex h-dvh max-w-2xl flex-col p-4">
      <h1 className="mb-3 text-sm font-medium text-zinc-300">
        Database hydration — DB seed ⧺ live channel
        <span className="ml-2 font-mono text-xs text-zinc-500">{chatId}</span>
      </h1>
      <ul
        data-testid="messages"
        className="flex flex-1 flex-col gap-2 overflow-y-auto"
      >
        {messages.map((message, index) => {
          const state = responseState(message, index);
          return (
            <li
              key={message.id}
              data-testid="message"
              data-role={message.role}
              data-id={message.id}
              data-state={state}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            >
              <span className="mr-2 font-mono text-xs text-zinc-500">{message.role}</span>
              {messageText(message)}
              {state && (
                <span
                  data-testid="message-state"
                  className="ml-2 font-mono text-[10px] uppercase tracking-wide text-zinc-500"
                >
                  {state}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <form
        onSubmit={handleSubmit}
        className="mt-3 flex gap-2"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Type a message..."
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500"
        />
        {streaming && latestRun ? (
          <button
            type="button"
            data-testid="stop"
            onClick={() => void session.cancel(latestRun.runId)}
            className="rounded-md bg-red-900/60 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/80"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
