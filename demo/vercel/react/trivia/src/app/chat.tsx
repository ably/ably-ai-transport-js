'use client';

import { useChat } from '@ai-sdk/react';
import { useChatTransport, useMessageSync, useView } from '@ably/ai-transport/vercel/react';
import { useCallback, useRef, useState } from 'react';
import { MessageList } from './components/message-list';
import { GamePane } from './components/game-pane';
import { SuggestionChips } from './components/suggestion-chips';
import { useTriviaState } from './hooks/use-trivia-state';
import { buildPlayerMessageParts, playerName } from './lib/trivia';
import { clientColor } from './lib/client-color';

// ---------------------------------------------------------------------------
// Chat component
// ---------------------------------------------------------------------------

export function Chat({ chatId, clientId, historyLimit }: { chatId: string; clientId: string; historyLimit?: number }) {
  // ChatTransport slot is created by ChatTransportProvider in page.tsx
  const { chatTransport, session } = useChatTransport();

  const { setMessages, sendMessage, stop, status } = useChat({
    id: chatId,
    transport: chatTransport,
  });

  useMessageSync({ setMessages });

  // The shared game state — roster, current question, scores — from
  // LiveObjects on the same channel as the conversation.
  const { snapshot, joined, join, error: gameError } = useTriviaState(session, clientId);

  // Show Stop while useChat is mid-request for a run this client owns.
  const hasAnyRuns = status === 'submitted' || status === 'streaming';

  // Auto-loads first page on mount
  const { messages, hasOlder, loading, loadOlder, runOf } = useView({
    limit: historyLimit ?? 30,
  });

  const myName = joined ? playerName(snapshot, clientId) : undefined;

  // Every outgoing message carries a data-player part so the agent can
  // attribute answers (user-message metadata doesn't roundtrip the wire).
  const sendAsPlayer = useCallback(
    (text: string) => {
      if (myName === undefined) return;
      void sendMessage({ parts: buildPlayerMessageParts(text, { clientId, name: myName }) });
    },
    [sendMessage, clientId, myName],
  );

  const handleJoin = useCallback(
    (name: string) => {
      join(name).catch((err: unknown) => {
        // The hook's self-heal retries on the next object update; log for diagnosis.
        console.error('trivia: join failed', err);
      });
    },
    [join],
  );

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  const phase = snapshot.game?.phase ?? 'lobby';
  const suggestions = joined && phase === 'lobby' ? ['Start the quiz!', 'Start a 3-question quiz about music'] : [];

  return (
    <div className="flex h-dvh">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          clientId={clientId}
          name={myName}
        />
        <MessageList
          messages={messages}
          hasOlder={hasOlder}
          loading={loading}
          runOf={runOf}
          onLoadOlder={loadOlder}
        />
        <div className="border-t border-zinc-800">
          <SuggestionChips
            prompts={suggestions}
            onSelectPrompt={handleSelectPrompt}
          />
          <InputBar
            value={input}
            onChange={setInput}
            inputRef={inputRef}
            onSend={sendAsPlayer}
            onStop={stop}
            hasAnyRuns={hasAnyRuns}
            disabled={!joined}
          />
        </div>
      </div>
      <GamePane
        snapshot={snapshot}
        clientId={clientId}
        joined={joined}
        onJoin={handleJoin}
        error={gameError}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ clientId, name }: { clientId: string; name: string | undefined }) {
  return (
    <header className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <h1 className="text-sm font-medium text-zinc-300">Ably Trivia Night — AI Transport + LiveObjects</h1>
        </div>
        <div className="flex items-center gap-2 pl-4">
          <a
            href="https://github.com/ably/ably-ai-transport-js"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
          >
            SDK repo
            <ExternalLinkIcon />
          </a>
          <a
            href="https://ably.com/docs/ai-transport"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
          >
            Ably docs
            <ExternalLinkIcon />
          </a>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.delete('clientId');
            window.open(url.toString(), '_blank');
          }}
          className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
          title="Open this game in a new tab as another player"
        >
          open in new tab
        </button>
        <span className={`font-mono text-xs ${clientColor(clientId).text}`}>{name ?? clientId}</span>
      </div>
    </header>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.75}
      stroke="currentColor"
      className="h-3 w-3"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
      />
    </svg>
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
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onSend: (text: string) => void;
  onStop: () => void;
  hasAnyRuns: boolean;
  disabled: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const text = value.trim();
        if (!text || disabled) return;
        onChange('');
        onSend(text);
      }}
      className="flex gap-2 px-4 py-3"
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={disabled ? 'Join the game to chat...' : 'Answer or chat with the quizmaster...'}
        disabled={disabled}
        className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500 disabled:opacity-50"
        autoFocus
      />
      {hasAnyRuns ? (
        <button
          type="button"
          onClick={onStop}
          className="rounded-md bg-red-900/60 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900/80"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={!value.trim() || disabled}
          className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      )}
    </form>
  );
}
