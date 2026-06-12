'use client';

/**
 * The game pane — rendered entirely from the LiveObjects snapshot, never from
 * chat messages. That's deliberate: a late joiner (or a reload) gets the
 * roster, current question, and scores from object state synced on attach,
 * before any conversation history has loaded.
 */

import { useState } from 'react';
import { clientColor } from '../lib/client-color';
import { playerName, scoreboard, type TriviaSnapshot } from '../lib/trivia';

interface GamePaneProps {
  snapshot: TriviaSnapshot;
  clientId: string;
  joined: boolean;
  onJoin: (name: string) => void;
  /** Error from resolving the object root, if any — rendered instead of the game. */
  error: Error | undefined;
}

export function GamePane({ snapshot, clientId, joined, onJoin, error }: GamePaneProps) {
  if (error) {
    return (
      <Pane title="Trivia Night">
        <div className="rounded-md bg-red-950/30 border border-red-900/30 px-3 py-2 text-xs text-red-400">
          Game state unavailable: {error.message}
        </div>
      </Pane>
    );
  }

  const phase = snapshot.game?.phase ?? 'lobby';

  return (
    <Pane title="Trivia Night">
      {phase === 'lobby' && (
        <Lobby
          snapshot={snapshot}
          clientId={clientId}
          joined={joined}
          onJoin={onJoin}
        />
      )}
      {phase === 'question' && (
        <>
          <QuestionCard snapshot={snapshot} />
          <Scoreboard
            snapshot={snapshot}
            clientId={clientId}
          />
          {!joined && (
            <JoinForm
              onJoin={onJoin}
              label="Join mid-game"
            />
          )}
        </>
      )}
      {phase === 'finished' && (
        <>
          <WinnerBanner snapshot={snapshot} />
          <Scoreboard
            snapshot={snapshot}
            clientId={clientId}
          />
        </>
      )}
    </Pane>
  );
}

// ---------------------------------------------------------------------------
// Layout shell
// ---------------------------------------------------------------------------

function Pane({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="flex w-80 flex-shrink-0 flex-col gap-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950/60 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">{title}</h2>
      {children}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function Lobby({
  snapshot,
  clientId,
  joined,
  onJoin,
}: {
  snapshot: TriviaSnapshot;
  clientId: string;
  joined: boolean;
  onJoin: (name: string) => void;
}) {
  const players = scoreboard(snapshot);

  return (
    <div className="flex flex-col gap-4">
      {!joined && <JoinForm onJoin={onJoin} />}
      <div>
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-600">
          Players ({players.length})
        </h3>
        {players.length === 0 ? (
          <p className="text-xs text-zinc-600">No one here yet — be the first to join.</p>
        ) : (
          <ul className="space-y-1">
            {players.map((row) => (
              <li
                key={row.clientId}
                className="flex items-center gap-2 text-sm"
              >
                <span className={`h-2 w-2 rounded-full bg-current ${clientColor(row.clientId).text}`} />
                <span className="text-zinc-300">{row.name}</span>
                {row.clientId === clientId && <span className="text-[10px] text-zinc-600">(you)</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {joined && (
        <p className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-500">
          Waiting to start. Anyone can say <span className="text-zinc-300">&ldquo;start the quiz&rdquo;</span> in chat —
          invite players with the <span className="text-zinc-300">open in new tab</span> button or by sharing the URL.
        </p>
      )}
    </div>
  );
}

function JoinForm({ onJoin, label }: { onJoin: (name: string) => void; label?: string }) {
  const [name, setName] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        onJoin(trimmed);
      }}
      className="flex flex-col gap-2"
    >
      <label
        htmlFor="player-name"
        className="text-[11px] font-medium uppercase tracking-wide text-zinc-600"
      >
        {label ?? 'Pick a name to play'}
      </label>
      <div className="flex gap-2">
        <input
          id="player-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={24}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-md bg-emerald-800 px-3 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Join
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Question card
// ---------------------------------------------------------------------------

function QuestionCard({ snapshot }: { snapshot: TriviaSnapshot }) {
  const game = snapshot.game;
  if (!game) return null;

  return (
    <div className="rounded-lg border border-indigo-800/40 bg-gradient-to-br from-indigo-950/60 to-zinc-900 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-indigo-400">
          Question {game.questionNumber} / {game.totalQuestions}
        </span>
        {game.category && <span className="text-[11px] text-zinc-500">{game.category}</span>}
      </div>
      {game.question ? (
        <p className="mt-2 text-sm leading-relaxed text-zinc-100">{game.question}</p>
      ) : (
        <p className="mt-2 animate-pulse text-sm text-zinc-500">The quizmaster is preparing a question&hellip;</p>
      )}
      <p className="mt-3 text-[11px] text-zinc-600">Answer in the chat — first correct answer takes the points.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------

function Scoreboard({ snapshot, clientId }: { snapshot: TriviaSnapshot; clientId: string }) {
  const rows = scoreboard(snapshot);
  if (rows.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-600">Scoreboard</h3>
      <ol className="space-y-1">
        {rows.map((row, index) => (
          <li
            key={row.clientId}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
              row.clientId === clientId ? 'bg-zinc-900' : ''
            }`}
          >
            <span className="w-4 text-right text-[11px] tabular-nums text-zinc-600">{index + 1}</span>
            <span className={`h-2 w-2 rounded-full bg-current ${clientColor(row.clientId).text}`} />
            <span className="min-w-0 flex-1 truncate text-zinc-300">{row.name}</span>
            <span className="font-mono text-sm tabular-nums text-zinc-100">{row.score}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Winner banner
// ---------------------------------------------------------------------------

function WinnerBanner({ snapshot }: { snapshot: TriviaSnapshot }) {
  const winnerClientId = snapshot.game?.winnerClientId;
  // Resolve through the roster; fall back to the raw clientId if the roster
  // entry is missing (e.g. it was a first-joiner race casualty).
  const name = winnerClientId ? playerName(snapshot, winnerClientId) : undefined;

  return (
    <div className="rounded-lg border border-amber-800/40 bg-gradient-to-br from-amber-950/60 to-zinc-900 p-4 text-center">
      <div className="text-2xl">&#127942;</div>
      <p className="mt-1 text-sm font-medium text-amber-200">{name ? `${name} wins!` : 'Quiz finished!'}</p>
      <p className="mt-1 text-[11px] text-zinc-500">Say &ldquo;play again&rdquo; in chat for a rematch.</p>
    </div>
  );
}
