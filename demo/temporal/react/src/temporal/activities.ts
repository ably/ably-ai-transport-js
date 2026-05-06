/**
 * Temporal activities backing the {@link runAgent} workflow.
 *
 * Each AIT step is one Temporal activity:
 *
 *   - {@link openRun} binds an {@link AgentRun} on the AIT session, caches
 *     it by `runId`, and returns the canonical conversation history as
 *     `AI.ModelMessage`s so the workflow can feed the first
 *     `streamText` call.
 *   - {@link streamStep} runs one model call (with any tools the model
 *     invokes) via `streamText`, pipes the resulting `UIMessageChunk`
 *     stream through the AIT step, and returns the iteration's finish
 *     reason and response messages so the workflow can decide whether
 *     to keep looping.
 *   - {@link endRun} ends the run (cleanly or with an error) and clears
 *     the cached handle.
 *
 * Tool execute functions run in-process inside `streamStep` — they don't
 * become their own Temporal activities. Keeping the LLM call and its
 * tool fan-out inside one activity keeps the wire shape close to the
 * vercel demo (one `streamText` per step) and avoids passing tool
 * call/result blobs through the workflow.
 */

import { Context } from '@temporalio/activity';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

import { Invocation, type InvocationData } from '@ably/ai-transport';

import { getSession } from '../lib/agent-session';
import { getBashToolkit } from '../lib/bash-session';
import { deleteRun, getRun, setRun } from '../lib/run-cache';

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';

/**
 * Per-step duration cap. One minute is comfortably longer than a single
 * `streamText` call should take while still bounding the wait for a
 * step-start ack on a misconfigured channel.
 */
const STEP_TIMEOUT_MS = 60_000;

/**
 * Number of `text-delta` chunks to forward before the synthetic failure
 * fires. Mirrors the vercel demo's behaviour so the user sees a partial
 * assistant bubble before the catch path lands a failed step-end.
 *
 * Only applied on the activity's first attempt — see `streamStep` below.
 * Temporal's retry of the activity then succeeds and the run completes
 * normally, demonstrating automatic recovery from a transient failure.
 */
const FAIL_AFTER_TEXT_DELTAS = 3;

/**
 * Wrap a `UIMessageChunk` stream so it errors after the model has
 * emitted {@link FAIL_AFTER_TEXT_DELTAS} text-delta chunks.
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

export async function openRun(data: InvocationData): Promise<void> {
  const invocation = Invocation.fromJSON(data);
  const session = await getSession(invocation.sessionName);
  const signal = Context.current().cancellationSignal;

  const run = await session.createRun(invocation, { signal });
  setRun(invocation.runId, run);
}

export interface StreamStepArgs {
  runId: string;
  /** Session name — used to resolve the bash toolkit for this run. */
  sessionName: string;
  /**
   * When true on the activity's first attempt, the step publishes a few
   * text-delta chunks then errors so the catch path lands a failed
   * step-end on the channel. The activity throws, Temporal retries it,
   * and the second attempt ignores the flag and runs normally — so the
   * run ultimately completes successfully after a visible transient
   * failure. The flag is effectively self-clearing across retries.
   */
  simulateFail?: boolean;
}

export interface StreamStepResult {
  /** Finish reason from the model. The workflow stops looping when it isn't `'tool-calls'`. */
  finishReason: AI.FinishReason;
  /**
   * True when the activity already ended the run (after observing an
   * abort). The workflow uses this to skip its trailing `endRun` so the
   * abort terminal is the only `run-end` published on the channel.
   */
  runEnded?: boolean;
}

export async function streamStep(args: StreamStepArgs): Promise<StreamStepResult> {
  const run = getRun(args.runId);
  if (run === undefined) {
    throw new Error(`unable to stream step; no cached run for ${args.runId}`);
  }
  const signal = Context.current().cancellationSignal;
  const { tools } = await getBashToolkit(args.sessionName);

  const step = run.createStep();
  await step.start({ signal, timeoutMs: STEP_TIMEOUT_MS });

  // Read canonical messages from the view AFTER step.start() lands so
  // any prior failed/aborted step in this run is excluded from the
  // model context. AIT-CN3 flips the predecessor's canonical flag when
  // our new step-start lands; reading the view before that flip would
  // feed retried/abandoned partial output back into streamText. Tree
  // FIFO guarantees prior iterations' completed output is visible too.
  // Spec: AIT-CN2.
  const messages = await convertToModelMessages(
    run.view.messages.filter((node) => node.canonical).map((node) => node.message),
  );

  try {
    // One model call per AIT step. `streamText` runs any tool calls the
    // model returns before the stream ends, so the step's output covers
    // both the assistant turn and its tool results.
    const result = streamText({
      model: anthropic(MODEL),
      messages,
      abortSignal: step.signal,
      tools,
      stopWhen: stepCountIs(1),
    });
    const source = result.toUIMessageStream();
    // Only fail on the first attempt. When Temporal retries the activity
    // the simulated-failure wrapper is skipped so the run recovers
    // automatically — this is what makes the demo show Temporal's retry
    // behaviour rather than a permanently-failed run.
    const failThisAttempt = args.simulateFail === true && Context.current().info.attempt === 1;
    const stream = failThisAttempt ? streamThatFailsAfterPartialText(source) : source;
    await step.pipe(stream);
    await step.end();

    const finishReason = await result.finishReason;
    return { finishReason };
  } catch (error) {
    await step.end(error);
    if (step.signal.aborted) {
      // Caller cancelled the run — end it here so the run-end terminal
      // is classified as `'aborted'` (the classifier needs the original
      // signal-driven error). Returning a marker tells the workflow to
      // skip its trailing `endRun`.
      await run.end(error);
      await run.close();
      deleteRun(args.runId);
      return { finishReason: 'other', runEnded: true };
    }
    throw error;
  }
}

export interface EndRunArgs {
  runId: string;
  /**
   * Set when the workflow caught an exception during the iteration loop.
   * Forwarded as `run.end(error)` so the AIT classifier picks `'failed'`
   * (or `'aborted'` for signal-driven errors).
   *
   * Activities can only carry serialisable arguments; the workflow
   * forwards the message string and we wrap it back into an Error here.
   */
  errorMessage?: string;
}

export async function endRun(args: EndRunArgs): Promise<void> {
  const run = getRun(args.runId);
  if (run === undefined) {
    // Already closed (e.g. activity retry after a successful close);
    // closing twice is a no-op on the underlying run anyway.
    return;
  }
  try {
    if (args.errorMessage !== undefined) {
      await run.end(new Error(args.errorMessage));
    } else {
      await run.end();
    }
  } finally {
    await run.close();
    deleteRun(args.runId);
  }
}
