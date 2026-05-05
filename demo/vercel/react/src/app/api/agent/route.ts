/**
 * Basic-chat agent endpoint with a synthetic-failure switch for the
 * retry demo.
 *
 * Inspired by `rfc/types/examples/vercel-serverless/basic-chat/agent.ts`.
 * One invocation = one run = one step. The handler reads the
 * {@link Invocation} from the request body, binds an {@link AgentRun}
 * to it, opens a step, pipes the model's UI message stream through it,
 * and ends the run.
 *
 * The request body extends {@link InvocationData} with an optional
 * `simulateFail` flag. When true, the handler throws after a few
 * stream chunks land so the catch path publishes
 * `step-end (failed)` + `run-end (failed)` and the response is HTTP 5xx.
 * The client opts in to that flag and treats the resulting error
 * response as expected. The user can then click Retry on the failed
 * bubble to re-run.
 *
 * The {@link AgentSession} is cached and pre-warmed by `instrumentation.ts`
 * at server boot so the channel is already attached and hydrated from
 * channel history before any client publishes onto it. `session.createRun`
 * waits for the invocation's preconditions (run-start visible and, when set,
 * `messageId` visible — either content or control-signal) to be satisfied.
 */

import { anthropic } from '@ai-sdk/anthropic';
import type * as AI from 'ai';
import { convertToModelMessages, jsonSchema, stepCountIs, streamText, tool } from 'ai';

import { Invocation, type InvocationData } from '@ably/ai-transport';

import { getSession } from '../../../lib/agent-session';

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';

interface AgentRequestBody extends InvocationData {
  /**
   * When true, the agent throws mid-stream so the run lands as
   * `'failed'`. Used by the retry demo to produce a deterministic
   * failed run without needing the model to genuinely error.
   */
  simulateFail?: boolean;
}

const getWeather = tool({
  description: 'Get the current weather for a city.',
  inputSchema: jsonSchema<{ city: string }>({
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  }),
  execute: ({ city }) =>
    Promise.resolve({
      city,
      temperatureC: 22,
      condition: 'sunny',
      humidity: 0.45,
    }),
});

/**
 * Number of `text-delta` chunks to forward before the synthetic failure
 * fires. Counting only text-deltas (not the surrounding metadata chunks
 * like `start` / `start-step` / `text-start`) ensures the consumer sees
 * visible partial content before the error. Three is enough to render a
 * meaningful partial bubble with the default Anthropic model, which
 * batches text into a small number of large deltas, while still firing
 * before short replies finish naturally.
 */
const FAIL_AFTER_TEXT_DELTAS = 3;

/**
 * Wrap a `UIMessageChunk` stream so it errors after the model has
 * emitted {@link FAIL_AFTER_TEXT_DELTAS} text-delta chunks. Produces
 * visible partial assistant content on the channel (so the demo can
 * show the half-finished failed bubble) before the catch path publishes
 * the failed terminal.
 * @param source The codec stream from `streamText().toUIMessageStream()`.
 * @returns A stream that pipes chunks through then errors after N text-deltas.
 */
const streamThatFailsAfterPartialText = (
  source: ReadableStream<AI.UIMessageChunk>,
): ReadableStream<AI.UIMessageChunk> => {
  const reader = source.getReader();
  let textDeltaCount = 0;
  return new ReadableStream<AI.UIMessageChunk>({
    pull: async (controller) => {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
      if (value.type === 'text-delta') {
        textDeltaCount++;
        if (textDeltaCount >= FAIL_AFTER_TEXT_DELTAS) {
          controller.error(new Error('simulated agent failure'));
        }
      }
    },
    cancel: (reason) => {
      reader.cancel(reason).catch(() => {
        /* swallow — best-effort upstream cancel */
      });
    },
  });
};

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as AgentRequestBody;
  const invocation = Invocation.fromJSON(body);
  const simulateFail = body.simulateFail === true;

  const session = await getSession(invocation.sessionName);

  await using run = await session.createRun(invocation, { signal: req.signal });
  await using step = run.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  try {
    const messages = await convertToModelMessages(run.view.messages.map((node) => node.message));
    const result = streamText({
      model: anthropic(MODEL),
      messages,
      abortSignal: step.signal,
      tools: { getWeather },
      stopWhen: stepCountIs(5),
    });
    const source = result.toUIMessageStream();
    await step.pipe(simulateFail ? streamThatFailsAfterPartialText(source) : source);
    await step.end();
    await run.end();
  } catch (error) {
    await step.end(error);
    await run.end(error);
    // Re-throw so the framework returns 5xx — that signals HTTP delivery
    // failure to the caller, including the demo's simulated failure (the
    // client opts in via `simulateFail` and handles the expected error).
    // The one suppressed case is aborts: the client cancelled the run,
    // the channel already carries the aborted terminal, and HTTP 202 is
    // the correct response.
    if (!step.signal.aborted) throw error;
  }

  return new Response(null, { status: 202 });
}
