import { describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import { FakeRoot, asRoot, type FakeState } from './fake-root';

// The tools create nested objects via LiveMap.create / LiveCounter.create;
// the mock returns markers the FakeRoot materializes into plain state.
vi.mock('ably/liveobjects', () => ({
  LiveMap: { create: (entries: Record<string, unknown> = {}) => ({ __kind: 'map-create', entries }) },
  LiveCounter: { create: (count = 0) => ({ __kind: 'counter-create', count }) },
}));

import { createTriviaTools } from '../api/chat/tools';

const PLAYERS = {
  a: { name: 'Alice', joinedAt: 1 },
  b: { name: 'Bob', joinedAt: 2 },
};

function setup(initial: FakeState) {
  const fake = new FakeRoot(initial);
  const tools = createTriviaTools(asRoot(fake));
  // Tool execute() is exercised directly; the demo only defines tools with
  // execute functions, so the run call goes through unconditionally.
  const run = async (name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool: Tool | undefined = tools[name];
    if (tool?.execute === undefined) throw new Error(`tool ${name} has no execute`);
    // CAST: tool inputs are validated by zod at runtime in the real pipeline;
    // tests pass well-formed inputs directly.
    const result = await tool.execute(input as never, { toolCallId: 't1', messages: [] });
    return result as Record<string, unknown>;
  };
  return { fake, run };
}

describe('startQuiz', () => {
  it('rejects when no players have joined', async () => {
    const { run } = setup({});
    const result = await run('startQuiz', { totalQuestions: 3 });
    expect(result.error).toMatch(/no players/);
  });

  it('rejects when a quiz is already in progress', async () => {
    const { run } = setup({
      game: { phase: 'question', questionNumber: 1, totalQuestions: 3 },
      players: PLAYERS,
      scores: {},
    });
    const result = await run('startQuiz', { totalQuestions: 3 });
    expect(result.error).toMatch(/already in progress/);
  });

  it('starts from the lobby and creates the game map if missing', async () => {
    const { fake, run } = setup({ players: PLAYERS, scores: {} });
    const result = await run('startQuiz', { totalQuestions: 3, category: 'Music' });
    expect(result).toEqual({ started: true, totalQuestions: 3, players: 2 });
    expect(fake.state.game).toMatchObject({
      phase: 'question',
      questionNumber: 0,
      totalQuestions: 3,
      category: 'Music',
    });
  });

  it('rematch from finished resets scores and clears the previous game', async () => {
    const { fake, run } = setup({
      game: {
        phase: 'finished',
        questionNumber: 3,
        totalQuestions: 3,
        question: 'Old?',
        category: 'Old',
        winnerClientId: 'a',
      },
      players: PLAYERS,
      scores: { a: 30, b: 10 },
    });
    const result = await run('startQuiz', { totalQuestions: 5 });
    expect(result).toMatchObject({ started: true, totalQuestions: 5 });
    expect(fake.state.scores).toEqual({ a: 0, b: 0 });
    expect(fake.state.game?.winnerClientId).toBeUndefined();
    expect(fake.state.game?.question).toBeUndefined();
    expect(fake.state.game?.category).toBeUndefined();
    expect(fake.state.game).toMatchObject({ phase: 'question', questionNumber: 0, totalQuestions: 5 });
  });
});

describe('askQuestion', () => {
  it('rejects when the quiz is not running', async () => {
    const { run } = setup({ players: PLAYERS, scores: {} });
    const result = await run('askQuestion', { question: 'Q?', category: 'General' });
    expect(result.error).toMatch(/not running/);
  });

  it('rejects when all questions have been asked', async () => {
    const { run } = setup({
      game: { phase: 'question', questionNumber: 3, totalQuestions: 3 },
      players: PLAYERS,
      scores: {},
    });
    const result = await run('askQuestion', { question: 'Q?', category: 'General' });
    expect(result.error).toMatch(/all questions/);
  });

  it('publishes the question and advances the counter', async () => {
    const { fake, run } = setup({
      game: { phase: 'question', questionNumber: 0, totalQuestions: 3 },
      players: PLAYERS,
      scores: {},
    });
    const result = await run('askQuestion', { question: 'Red planet?', category: 'Space' });
    expect(result).toEqual({ published: true, questionNumber: 1, of: 3 });
    expect(fake.state.game).toMatchObject({ question: 'Red planet?', category: 'Space', questionNumber: 1 });
  });
});

describe('awardPoints', () => {
  const RUNNING: FakeState = {
    game: { phase: 'question', questionNumber: 1, totalQuestions: 3, question: 'Q?' },
    players: PLAYERS,
    scores: { a: 10 },
  };

  it('rejects an unknown player', async () => {
    const { run } = setup({ ...RUNNING, scores: { ...RUNNING.scores } });
    const result = await run('awardPoints', { playerClientId: 'ghost', points: 10, reason: 'r' });
    expect(result.error).toMatch(/unknown player/);
  });

  it('rejects when the quiz is not running', async () => {
    const { run } = setup({ players: PLAYERS, scores: {} });
    const result = await run('awardPoints', { playerClientId: 'a', points: 10, reason: 'r' });
    expect(result.error).toMatch(/not running/);
  });

  it('increments an existing counter', async () => {
    const { fake, run } = setup({ ...RUNNING, scores: { a: 10 } });
    const result = await run('awardPoints', { playerClientId: 'a', points: 10, reason: 'first correct answer' });
    expect(result).toEqual({ awarded: 10, playerName: 'Alice', playerClientId: 'a', reason: 'first correct answer' });
    expect(fake.state.scores).toEqual({ a: 20 });
  });

  it('creates a missing counter before incrementing (self-heal)', async () => {
    const { fake, run } = setup({ ...RUNNING, scores: {} });
    const result = await run('awardPoints', { playerClientId: 'b', points: 10, reason: 'r' });
    expect(result).toMatchObject({ awarded: 10, playerName: 'Bob' });
    expect(fake.state.scores).toEqual({ b: 10 });
  });
});

describe('endQuiz', () => {
  it('rejects when the quiz is not running', async () => {
    const { run } = setup({ players: PLAYERS, scores: {} });
    const result = await run('endQuiz', { winnerClientId: 'a' });
    expect(result.error).toMatch(/not running/);
  });

  it('rejects an unknown winner', async () => {
    const { run } = setup({
      game: { phase: 'question', questionNumber: 3, totalQuestions: 3 },
      players: PLAYERS,
      scores: {},
    });
    const result = await run('endQuiz', { winnerClientId: 'ghost' });
    expect(result.error).toMatch(/unknown player/);
  });

  it('finishes the game and records the winner', async () => {
    const { fake, run } = setup({
      game: { phase: 'question', questionNumber: 3, totalQuestions: 3 },
      players: PLAYERS,
      scores: { a: 30, b: 10 },
    });
    const result = await run('endQuiz', { winnerClientId: 'a' });
    expect(result).toEqual({ finished: true, winnerName: 'Alice', winnerClientId: 'a' });
    expect(fake.state.game).toMatchObject({ phase: 'finished', winnerClientId: 'a' });
  });
});
