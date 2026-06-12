/**
 * Quizmaster tools — every game-state mutation the agent can perform, closing
 * over the channel's LiveObjects root.
 *
 * All tools are server-executed. Guards live here, not in the model: each tool
 * re-reads the object and returns a descriptive `{ error }` result when the
 * call doesn't fit the current phase, so a confused model self-corrects
 * instead of corrupting state. Guard failures are results, never throws.
 *
 * Concurrency: every player answer is its own agent run, so tools from
 * concurrent runs can interleave. LiveObjects has no cross-call transactions,
 * so the guards are read-then-write — best-effort, not atomic. The demo keeps
 * the failure modes benign: game-map writes are batched (one channel message,
 * no partial states), score resets decrement by the value read at decrement
 * time, and the racy outcomes that remain (two runs advancing the question at
 * once) cost a question slot, not game integrity.
 *
 * Score counters are `LiveCounter`s so concurrent awards merge; `awardPoints`
 * lazily creates a missing counter (the client only creates counters in the
 * lobby — see `useTriviaState` — so a mid-game `set` can never wipe points).
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import { LiveCounter, LiveMap } from 'ably/liveobjects';
import type { LiveMapPathObject } from 'ably/liveobjects';
import { snapshotFrom, type GameMeta, type TriviaRoot, type TriviaSnapshot } from '../../lib/trivia';

type Root = LiveMapPathObject<TriviaRoot>;

const snapshot = (root: Root): TriviaSnapshot => snapshotFrom(root.compactJson());

/** Zero every score counter — used when restarting from a finished game. */
const resetScores = async (root: Root, scores: Record<string, number>): Promise<void> => {
  for (const clientId of Object.keys(scores)) {
    const counter = root.get('scores').get(clientId);
    // Decrement by the counter's value at decrement time (not the snapshot's),
    // so a concurrent reset or award narrows to a millisecond window rather
    // than a guaranteed double-decrement.
    const value = counter.value();
    if (value !== undefined && value !== 0) {
      await counter.decrement(value);
    }
  }
};

export function createTriviaTools(root: Root): Record<string, Tool> {
  return {
    startQuiz: {
      description:
        'Start the quiz (or a rematch after one has finished). Sets the number of questions and moves the game out of the lobby. Call askQuestion immediately afterwards to publish the first question.',
      inputSchema: z.object({
        totalQuestions: z.number().int().min(1).max(20).describe('How many questions the quiz will have'),
        category: z.string().optional().describe('Overall topic for the quiz, if the players asked for one'),
      }),
      execute: async ({ totalQuestions, category }: { totalQuestions: number; category?: string }) => {
        const s = snapshot(root);
        if (Object.keys(s.players).length === 0) {
          return { error: 'no players have joined yet; ask players to join from the game pane first' };
        }
        if (s.game && s.game.phase === 'question') {
          return { error: 'a quiz is already in progress' };
        }
        if (root.get('game').instance() === undefined) {
          const initial: GameMeta = { phase: 'lobby', questionNumber: 0, totalQuestions: 0 };
          await root.set('game', LiveMap.create(initial));
        }
        // Rematch: zero the previous game's scores.
        if (s.game?.phase === 'finished') {
          await resetScores(root, s.scores);
        }
        // One batch → one channel message: clients never see a partially
        // started game, and concurrent startQuiz calls can't interleave
        // within the game map.
        await root.get('game').batch((game) => {
          game.remove('winnerClientId');
          game.remove('question');
          game.set('totalQuestions', totalQuestions);
          game.set('questionNumber', 0);
          if (category !== undefined) {
            game.set('category', category);
          } else {
            game.remove('category');
          }
          game.set('phase', 'question');
        });
        return { started: true, totalQuestions, players: Object.keys(s.players).length };
      },
    },

    askQuestion: {
      description:
        'Publish the next question to the shared game board. Call this once per question, after startQuiz or after the previous question is settled. Also say the question in chat with your own flair.',
      inputSchema: z.object({
        question: z.string().describe('The trivia question text'),
        category: z.string().describe('Short category label for this question, e.g. "Geography"'),
      }),
      execute: async ({ question, category }: { question: string; category: string }) => {
        const s = snapshot(root);
        if (s.game === undefined || s.game.phase !== 'question') {
          return { error: 'quiz is not running; call startQuiz first' };
        }
        if (s.game.questionNumber >= s.game.totalQuestions) {
          return { error: 'all questions have been asked; call endQuiz to finish the game' };
        }
        const questionNumber = s.game.questionNumber + 1;
        // One batch → one channel message: question text, category, and number
        // change together, so clients never render a mismatched pair.
        await root.get('game').batch((game) => {
          game.set('question', question);
          game.set('category', category);
          game.set('questionNumber', questionNumber);
        });
        return { published: true, questionNumber, of: s.game.totalQuestions };
      },
    },

    awardPoints: {
      description:
        'Award points to a player for a correct answer. Identify the player by the clientId from the "Name (clientId xyz) says:" attribution on their message.',
      inputSchema: z.object({
        playerClientId: z.string().describe('The clientId of the player to award points to'),
        points: z.number().int().min(1).max(100).describe('How many points to award (typically 10)'),
        reason: z.string().describe('One short clause explaining the award, e.g. "first correct answer"'),
      }),
      execute: async ({
        playerClientId,
        points,
        reason,
      }: {
        playerClientId: string;
        points: number;
        reason: string;
      }) => {
        const s = snapshot(root);
        const player = s.players[playerClientId];
        if (player === undefined) {
          return { error: `unknown player clientId "${playerClientId}"; use a clientId from the message attributions` };
        }
        if (s.game === undefined || s.game.phase !== 'question') {
          return { error: 'quiz is not running; points can only be awarded during a quiz' };
        }
        const counter = root.get('scores').get(playerClientId);
        if (counter.value() === undefined) {
          // Heal a missing counter (lost first-joiner race) before incrementing.
          await root.get('scores').set(playerClientId, LiveCounter.create(0));
        }
        await counter.increment(points);
        return { awarded: points, playerName: player.name, playerClientId, reason };
      },
    },

    endQuiz: {
      description:
        'Finish the quiz and declare the winner. Call this after the final question is settled, passing the clientId of the highest-scoring player.',
      inputSchema: z.object({
        winnerClientId: z.string().describe('The clientId of the winning player'),
      }),
      execute: async ({ winnerClientId }: { winnerClientId: string }) => {
        const s = snapshot(root);
        if (s.game === undefined || s.game.phase !== 'question') {
          return { error: 'quiz is not running; there is nothing to end' };
        }
        const winner = s.players[winnerClientId];
        if (winner === undefined) {
          return { error: `unknown player clientId "${winnerClientId}"; use a clientId from the scoreboard` };
        }
        await root.get('game').batch((game) => {
          game.set('winnerClientId', winnerClientId);
          game.set('phase', 'finished');
        });
        return { finished: true, winnerName: winner.name, winnerClientId };
      },
    },
  };
}
