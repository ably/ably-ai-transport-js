/**
 * Basic-chat agent endpoint with a synthetic-failure switch for the
 * retry demo.
 *
 * Inspired by `rfc/types/examples/vercel-serverless/basic-chat/agent.ts`.
 * One invocation = one run, with one AIT step per model+tool-call
 * iteration. The handler reads the {@link Invocation} from the request
 * body, binds an {@link AgentRun} to it, then drives the model loop
 * manually: each iteration opens a fresh step, calls `streamText` with
 * `stepCountIs(1)` (one model call per step), pipes the resulting UI
 * message stream through the step, and continues until the model
 * returns a non-`tool-calls` finish reason or the iteration cap is hit.
 *
 * Driving the loop manually (rather than letting `streamText` handle
 * multiple iterations internally inside one step) makes the
 * iteration→step mapping explicit on the wire: every iteration carries
 * its own `step-start`/`step-end` lifecycle and its own `step.signal`
 * (caller signal + per-step timeout + AIT control signals).
 *
 * The request body extends {@link InvocationData} with an optional
 * `simulateFail` flag. When true, the first iteration throws after a
 * few stream chunks land so the catch path publishes
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
import { convertToModelMessages, stepCountIs, streamText } from 'ai';

import { Invocation, type InvocationData } from '@ably/ai-transport';

import { getSession } from '../../../lib/agent-session';
import { getBashToolkit } from '../../../lib/bash-session';

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';

/**
 * Hard cap on iterations per run. Each iteration is one model call (with
 * any tool calls it returns executed before the next iteration begins).
 * Mirrors the `stepCountIs(10)` cap the previous single-step
 * implementation passed to `streamText`.
 */
const MAX_ITERATIONS = 10;

interface AgentRequestBody extends InvocationData {
  /**
   * When true, the agent throws mid-stream so the run lands as
   * `'failed'`. Used by the retry demo to produce a deterministic
   * failed run without needing the model to genuinely error.
   */
  simulateFail?: boolean;
}

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
  const { tools } = await getBashToolkit(invocation.sessionName);

  await using run = await session.createRun(invocation, { signal: req.signal });

  let messages: AI.ModelMessage[] = [];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    await using step = run.createStep();
    await step.start({ signal: req.signal, timeoutMs: 60_000 });

    if (iteration === 0) {
      // Filter out non-canonical nodes — output from retried/abandoned/
      // superseded prior step attempts the tree has flagged as no
      // longer contributing to the run's current state (Spec: AIT-CN2).
      // Reading after the first step.start() ensures any retire of a
      // prior failed/aborted step in this run has happened: AIT-CN3
      // flips the predecessor's canonical flag when our new step-start
      // lands, so its partial output is excluded from the model
      // context. Subsequent iterations skip this and feed forward the
      // previous iteration's response messages instead.
      messages = await convertToModelMessages(
        run.view.messages.filter((node) => node.canonical).map((node) => node.message),
      );
    }

    try {
      // One model call per AIT step. `streamText` still executes any
      // tool calls the model returns before the stream ends, so the
      // step's encoded output covers both the assistant turn and its
      // tool results.
      const result = streamText({
        model: anthropic(MODEL),
        messages,
        abortSignal: step.signal,
        tools,
        stopWhen: stepCountIs(1),
      });
      const source = result.toUIMessageStream();
      // Only fail the first iteration so the demo produces a single
      // failed step the user can retry, regardless of how many
      // iterations a successful run would have taken.
      const simulate = simulateFail && iteration === 0;
      await step.pipe(simulate ? streamThatFailsAfterPartialText(source) : source);
      await step.end();

      // Stop the loop if the model didn't request more tool calls.
      // Otherwise feed the iteration's response (assistant turn + tool
      // results) forward as input to the next model call.
      if ((await result.finishReason) !== 'tool-calls') break;
      messages = [...messages, ...(await result.response).messages];
    } catch (error) {
      await step.end(error);
      await run.end(error);
      // Re-throw so the framework returns 5xx — that signals HTTP
      // delivery failure to the caller, including the demo's simulated
      // failure (the client opts in via `simulateFail` and handles the
      // expected error). The one suppressed case is aborts: the client
      // cancelled the run, the channel already carries the aborted
      // terminal, and HTTP 202 is the correct response.
      if (!step.signal.aborted) throw error;
      return new Response(null, { status: 202 });
    }
  }

  await run.end();
  return new Response(null, { status: 202 });
}
