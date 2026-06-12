import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import {
  buildPlayerMessageParts,
  playerAttributionText,
  playerFromMessage,
  playerName,
  scoreboard,
  snapshotFrom,
  EMPTY_SNAPSHOT,
  PLAYER_DATA_PART,
} from '../lib/trivia';

describe('snapshotFrom', () => {
  it('returns the empty snapshot for non-object input', () => {
    expect(snapshotFrom(undefined)).toEqual(EMPTY_SNAPSHOT);
    expect(snapshotFrom(null)).toEqual(EMPTY_SNAPSHOT);
    expect(snapshotFrom('nope')).toEqual(EMPTY_SNAPSHOT);
    expect(snapshotFrom([])).toEqual(EMPTY_SNAPSHOT);
  });

  it('parses a well-formed compacted root', () => {
    const snapshot = snapshotFrom({
      game: { phase: 'question', questionNumber: 2, totalQuestions: 5, question: 'Q?', category: 'Music' },
      players: { a: { name: 'Alice', joinedAt: 1 }, b: { name: 'Bob', joinedAt: 2 } },
      scores: { a: 10, b: 0 },
    });
    expect(snapshot.game).toEqual({
      phase: 'question',
      questionNumber: 2,
      totalQuestions: 5,
      question: 'Q?',
      category: 'Music',
    });
    expect(Object.keys(snapshot.players)).toEqual(['a', 'b']);
    expect(snapshot.scores).toEqual({ a: 10, b: 0 });
  });

  it('drops malformed game, player, and score entries', () => {
    const snapshot = snapshotFrom({
      game: { phase: 'intermission', questionNumber: 1, totalQuestions: 5 }, // invalid phase
      players: {
        a: { name: 'Alice', joinedAt: 1 },
        bad1: { name: 42, joinedAt: 1 },
        bad2: 'not-an-entry',
      },
      scores: { a: 10, bad: 'ten' },
    });
    expect(snapshot.game).toBeUndefined();
    expect(Object.keys(snapshot.players)).toEqual(['a']);
    expect(snapshot.scores).toEqual({ a: 10 });
  });

  it('omits optional game fields that are not strings', () => {
    const snapshot = snapshotFrom({
      game: { phase: 'finished', questionNumber: 5, totalQuestions: 5, winnerClientId: 7 },
    });
    expect(snapshot.game).toEqual({ phase: 'finished', questionNumber: 5, totalQuestions: 5 });
  });
});

describe('scoreboard', () => {
  it('includes every player, defaulting missing counters to 0', () => {
    const rows = scoreboard({
      game: undefined,
      players: { a: { name: 'Alice', joinedAt: 1 }, b: { name: 'Bob', joinedAt: 2 } },
      scores: { a: 10 },
    });
    expect(rows).toEqual([
      { clientId: 'a', name: 'Alice', score: 10 },
      { clientId: 'b', name: 'Bob', score: 0 },
    ]);
  });

  it('sorts by score descending, then join time ascending for ties', () => {
    const rows = scoreboard({
      game: undefined,
      players: {
        late: { name: 'Late', joinedAt: 3 },
        early: { name: 'Early', joinedAt: 1 },
        top: { name: 'Top', joinedAt: 2 },
      },
      scores: { late: 10, early: 10, top: 20 },
    });
    expect(rows.map((r) => r.clientId)).toEqual(['top', 'early', 'late']);
  });
});

describe('playerName', () => {
  it('resolves through the roster with a clientId fallback', () => {
    const snapshot = { game: undefined, players: { a: { name: 'Alice', joinedAt: 1 } }, scores: {} };
    expect(playerName(snapshot, 'a')).toBe('Alice');
    expect(playerName(snapshot, 'ghost')).toBe('ghost');
  });
});

describe('player attribution parts', () => {
  it('builds the data part first so the prefix precedes the answer', () => {
    const parts = buildPlayerMessageParts('Mars', { clientId: 'a', name: 'Alice' });
    expect(parts).toEqual([
      { type: PLAYER_DATA_PART, id: 'a', data: { clientId: 'a', name: 'Alice' } },
      { type: 'text', text: 'Mars' },
    ]);
  });

  it('roundtrips through playerFromMessage', () => {
    const message: UIMessage = {
      id: 'm1',
      role: 'user',
      parts: buildPlayerMessageParts('Mars', { clientId: 'a', name: 'Alice' }),
    };
    expect(playerFromMessage(message)).toEqual({ clientId: 'a', name: 'Alice' });
  });

  it('returns undefined when the part is absent or malformed', () => {
    const noPart: UIMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    expect(playerFromMessage(noPart)).toBeUndefined();

    const malformed: UIMessage = {
      id: 'm2',
      role: 'user',
      parts: [{ type: PLAYER_DATA_PART, data: { clientId: 42 } }],
    };
    expect(playerFromMessage(malformed)).toBeUndefined();
  });

  it('renders an attribution prefix, tolerating malformed payloads', () => {
    expect(playerAttributionText({ clientId: 'a', name: 'Alice' })).toBe('Alice (clientId a) says:');
    expect(playerAttributionText(undefined)).toBe('An unidentified player says:');
    expect(playerAttributionText({ name: 'NoId' })).toBe('An unidentified player says:');
  });
});
