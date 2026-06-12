/**
 * Shared trivia game types and pure helpers, used by both the browser UI and
 * the agent endpoint.
 *
 * The game state lives in Ably LiveObjects on the session channel, alongside
 * the conversation:
 *
 * - `game`    — quiz progress (phase, current question). Written only by the agent.
 * - `players` — roster, keyed by clientId. Each client writes only its own entry.
 * - `scores`  — one LiveCounter per player, so concurrent point awards merge.
 *
 * Write ownership is per key: no key ever has two concurrent writers racing on
 * `set`. The only multi-writer operation is `LiveCounter.increment`, which is
 * commutative by design.
 */

import type { LiveCounter, LiveMap } from 'ably/liveobjects';
import { isDataUIPart, type UIMessage } from 'ai';

// ---------------------------------------------------------------------------
// Object schema
// ---------------------------------------------------------------------------

export type GamePhase = 'lobby' | 'question' | 'finished';

// Type aliases, not interfaces: LiveMap's parameter is constrained to
// `Record<string, Value>`, and interfaces have no implicit index signature.

/** A player's roster entry — plain JSON, written by that player at join. */
export type PlayerEntry = {
  name: string; // display name (clientIds are random; names needn't be unique)
  joinedAt: number;
};

/** Quiz progress — written only by the agent. Flat primitives, LWW per key. */
export type GameMeta = {
  phase: GamePhase;
  questionNumber: number; // 1-based; 0 before the first question
  totalQuestions: number;
  question?: string;
  category?: string;
  winnerClientId?: string; // set by the endQuiz tool
};

/** The structure of the channel's root object. */
export type TriviaRoot = {
  game: LiveMap<GameMeta>;
  players: LiveMap<Record<string, PlayerEntry>>; // keyed by clientId
  scores: LiveMap<Record<string, LiveCounter>>; // keyed by clientId
};

// ---------------------------------------------------------------------------
// Snapshot — plain-JS view of the object state
// ---------------------------------------------------------------------------

/**
 * A plain, validated snapshot of the game state, derived from the root
 * object's `compactJson()`. Both the React game pane and the agent's system
 * prompt render from this shape.
 */
export interface TriviaSnapshot {
  game: GameMeta | undefined;
  players: Record<string, PlayerEntry>;
  scores: Record<string, number>;
}

export const EMPTY_SNAPSHOT: TriviaSnapshot = { game: undefined, players: {}, scores: {} };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const GAME_PHASES: readonly string[] = ['lobby', 'question', 'finished'] satisfies GamePhase[];

const isGamePhase = (value: string): value is GamePhase => GAME_PHASES.includes(value);

const parseGame = (value: unknown): GameMeta | undefined => {
  if (!isRecord(value)) return undefined;
  const { phase, questionNumber, totalQuestions, question, category, winnerClientId } = value;
  if (typeof phase !== 'string' || !isGamePhase(phase)) return undefined;
  if (typeof questionNumber !== 'number' || typeof totalQuestions !== 'number') return undefined;
  return {
    phase,
    questionNumber,
    totalQuestions,
    ...(typeof question === 'string' ? { question } : {}),
    ...(typeof category === 'string' ? { category } : {}),
    ...(typeof winnerClientId === 'string' ? { winnerClientId } : {}),
  };
};

const parsePlayers = (value: unknown): Record<string, PlayerEntry> => {
  if (!isRecord(value)) return {};
  const players: Record<string, PlayerEntry> = {};
  for (const [clientId, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const { name, joinedAt } = entry;
    if (typeof name !== 'string' || typeof joinedAt !== 'number') continue;
    players[clientId] = { name, joinedAt };
  }
  return players;
};

const parseScores = (value: unknown): Record<string, number> => {
  if (!isRecord(value)) return {};
  const scores: Record<string, number> = {};
  for (const [clientId, score] of Object.entries(value)) {
    if (typeof score !== 'number') continue;
    scores[clientId] = score;
  }
  return scores;
};

/**
 * Normalize a root `compactJson()` value into a {@link TriviaSnapshot}.
 *
 * The compacted value is wire-derived state (and typed with `ObjectIdReference`
 * arms for cycles we never create), so every field is runtime-validated rather
 * than trusted; anything malformed is dropped.
 */
export function snapshotFrom(compacted: unknown): TriviaSnapshot {
  if (!isRecord(compacted)) return EMPTY_SNAPSHOT;
  return {
    game: parseGame(compacted.game),
    players: parsePlayers(compacted.players),
    scores: parseScores(compacted.scores),
  };
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------

/** One row of the rendered scoreboard. */
export interface ScoreboardRow {
  clientId: string;
  name: string;
  score: number;
}

/**
 * Build the scoreboard: every joined player, scored (default 0 when the
 * counter hasn't been created yet), sorted by score descending, then by join
 * time ascending so ties keep a stable order.
 */
export function scoreboard(snapshot: TriviaSnapshot): ScoreboardRow[] {
  return Object.entries(snapshot.players)
    .map(([clientId, entry]) => ({ clientId, name: entry.name, score: snapshot.scores[clientId] ?? 0 }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return (snapshot.players[a.clientId]?.joinedAt ?? 0) - (snapshot.players[b.clientId]?.joinedAt ?? 0);
    });
}

/** Resolve a player's display name, falling back to the raw clientId. */
export function playerName(snapshot: TriviaSnapshot, clientId: string): string {
  return snapshot.players[clientId]?.name ?? clientId;
}

// ---------------------------------------------------------------------------
// Player attribution — `data-player` part on every user message
// ---------------------------------------------------------------------------

/**
 * The agent cannot see which client published a message (the transport's
 * `inputClientId` is not public API), and user-message `metadata` does not
 * roundtrip the wire — but `data-*` parts do. So every answer carries a
 * `data-player` part identifying the sender, and the agent endpoint converts
 * it to a text prefix for the model.
 */
export const PLAYER_DATA_PART = 'data-player';

/** The payload of a `data-player` part. */
export interface PlayerData {
  clientId: string;
  name: string;
}

const isPlayerData = (value: unknown): value is PlayerData =>
  isRecord(value) && typeof value.clientId === 'string' && typeof value.name === 'string';

/**
 * Build the parts of an outgoing user message: the attribution part first
 * (so the model reads "Alice says:" before the answer), then the text.
 */
export function buildPlayerMessageParts(text: string, player: PlayerData): UIMessage['parts'] {
  return [
    { type: PLAYER_DATA_PART, id: player.clientId, data: { clientId: player.clientId, name: player.name } },
    { type: 'text', text },
  ];
}

/** Extract the sender from a message's `data-player` part, if present and valid. */
export function playerFromMessage(message: UIMessage): PlayerData | undefined {
  for (const part of message.parts) {
    if (!isDataUIPart(part) || part.type !== PLAYER_DATA_PART) continue;
    if (isPlayerData(part.data)) return { clientId: part.data.clientId, name: part.data.name };
  }
  return undefined;
}

/**
 * Render a `data-player` part's payload as the attribution prefix the model
 * sees. Tolerates malformed payloads (the part is client-asserted wire data)
 * rather than throwing mid-conversion.
 */
export function playerAttributionText(data: unknown): string {
  if (isPlayerData(data)) return `${data.name} (clientId ${data.clientId}) says:`;
  return 'An unidentified player says:';
}
