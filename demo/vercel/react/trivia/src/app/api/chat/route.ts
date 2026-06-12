/**
 * Quizmaster API route — receives invocations from the client session's HTTP
 * POST, streams the AI quizmaster's response back over Ably, and mutates the
 * shared LiveObjects game state through tools.
 *
 * Per run, the route:
 * 1. Resolves the channel's LiveObjects root (object state syncs on attach,
 *    so the per-request ephemeral client always sees current state).
 * 2. Embeds a JSON snapshot of the game (phase, question, roster, scores) in
 *    the system prompt, so the model needs no conversation archaeology.
 * 3. Converts each message's `data-player` part into a "Name (clientId xyz)
 *    says:" prefix via `convertDataPart` — the agent has no other way to know
 *    which player sent a message.
 * 4. Hands the model the four game tools (startQuiz / askQuestion /
 *    awardPoints / endQuiz), which write to the object. Tool writes are
 *    awaited inside execute, and `run.pipe` does not resolve until the
 *    multi-step stream (tool executions included) finishes — so all object
 *    writes land before the session closes.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import Ably from 'ably';
import { LiveObjects } from 'ably/liveobjects';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation, OBJECT_MODES } from '@ably/ai-transport';
import { createModel } from './model';
import { createTriviaTools } from './tools';
import {
  PLAYER_DATA_PART,
  playerAttributionText,
  snapshotFrom,
  type TriviaRoot,
  type TriviaSnapshot,
} from '../../lib/trivia';

const systemPrompt = (
  snapshot: TriviaSnapshot,
): string => `You are the quizmaster of "Ably Trivia Night", a live multiplayer trivia game. Multiple players share this conversation; a game pane next to the chat shows the roster, current question, and scores, driven by the shared game state you control through your tools.

Current game state (live, authoritative):
${JSON.stringify(snapshot, null, 2)}

Player messages are prefixed "Name (clientId xyz) says:". Always use that clientId when awarding points or declaring a winner — never invent one.

How to run the game:
- In the lobby, welcome players and build hype. When anyone asks to start, call startQuiz (default 5 questions unless they ask otherwise), then immediately call askQuestion with the first question.
- Write fun, varied trivia questions with a definite, checkable answer. Use the requested category if there is one; otherwise mix categories. Number difficulty up gently.
- Always call askQuestion when posing a question — the question must reach the shared board, not just the chat. Repeat the question in chat with your own flair.
- Judge answers against the current question. Accept reasonable phrasings and minor misspellings. The first correct answer earns 10 points via awardPoints; later duplicates of the same correct answer earn nothing (say so cheerfully). Wrong answers get a short, playful nudge — never reveal the answer until someone gets it or gives up.
- After awarding points for a correct answer: if questions remain, call askQuestion with the next one in the same turn; if that was the last question, call endQuiz with the highest scorer's clientId and celebrate.
- If a tool returns an error, trust it: re-read the game state above and correct course.
- Keep every chat message short and punchy — two or three sentences, game-show energy, no walls of text.`;

export async function POST(req: Request) {
  // CAST: trust boundary — JSON body from the client transport's POST.
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  // A fresh Ably client per request (trusted environment, API key direct).
  // The agent is ephemeral: it attaches the channel, looks up the triggering
  // input event via `untilAttach: true` history (scoped by
  // `inputEventLookbackMs`), streams the response, and closes. A per-request
  // client keeps concurrent runs on the same channel from detaching each
  // other — and concurrent runs are normal here, since every player's answer
  // is its own run.
  // `ABLY_ENDPOINT` lets you point the agent at a non-production Ably
  // endpoint (e.g. `nonprod:sandbox`); unset in normal use. It must match the
  // endpoint the browser client connects to.
  const ably = new Ably.Realtime({
    key: process.env.ABLY_API_KEY!,
    plugins: { LiveObjects },
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });

  const session = createAgentSession({
    client: ably,
    channelName: invocation.sessionName,
    channelModes: OBJECT_MODES,
  });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();

  let result;
  try {
    await run.loadConversation();

    // Object state is synced by the time get() resolves; the snapshot reflects
    // every write that happened before this run. This rejects when LiveObjects
    // is unavailable, and createModel() throws without a provider key — both
    // after run-start has been published, hence the catch below.
    const root = await session.object.get<TriviaRoot>();
    const snapshot = snapshotFrom(root.compactJson());

    result = streamText({
      model: createModel(),
      system: systemPrompt(snapshot),
      messages: await convertToModelMessages(run.messages, {
        // Surface each message's data-player part as an attribution prefix —
        // without it the model cannot tell the players apart.
        convertDataPart: (part) =>
          part.type === PLAYER_DATA_PART ? { type: 'text', text: playerAttributionText(part.data) } : undefined,
      }),
      tools: createTriviaTools(root),
      abortSignal: run.abortSignal,
      stopWhen: stepCountIs(8),
    });
  } catch (error) {
    // The run has already started on the channel; end it so clients don't see
    // a permanently active run, then release the connection.
    await run.end('error');
    await session.close();
    ably.close();
    throw error;
  }

  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream());
    const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    if (outcome === 'suspend') {
      await run.suspend();
    } else {
      await run.end(outcome);
    }
    await session.close();
    ably.close();
  });

  // Return the agent-minted ids on the HTTP response. The useChat
  // ChatTransport's POST ignores the body (it routes by run-id over the
  // channel), but the contract is honoured here.
  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
