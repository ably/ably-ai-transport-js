/**
 * Prompt-chaining workflow — durable-execution variant.
 *
 * Pattern per Anthropic, "Building Effective Agents"
 * (https://www.anthropic.com/engineering/building-effective-agents):
 * decompose a task into a fixed sequence of LLM calls where each step
 * consumes the previous step's output. No loops, no dynamic routing.
 *
 * Structural contrast with the serverless variant
 * (`vercel-serverless/prompt-chaining/agent.ts`):
 *
 *   Serverless: one HTTP handler, one session, one view, two
 *               `view.createStep()` calls. Shared session means the
 *               view materialises once; the second step's start() sees
 *               preconditions already satisfied.
 *
 *   Durable:    each LLM call is its own `"use step"` WDK function —
 *               each hop opens a fresh session, view, and transport
 *               step, so WDK's replay / retry / crash-recovery work
 *               per hop. The outline is published by `planHop` as an
 *               assistant turn on the channel; `draftHop` reads it
 *               back via `view.messages` after hydrating, so the
 *               outline does not need to flow through WDK step return
 *               values — the channel is already the durable record.
 *
 * Three hops:
 *   1. planHop  — generates the outline and publishes it to the channel.
 *   2. draftHop — reads view.messages, streams the final answer.
 *   3. endRun   — writer-only terminal publish (plan §5.7).
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, generateText, streamText } from 'ai';
import { getWritable } from 'workflow';

import type { Codec, InvocationData, StorageReader } from '../../../index.js';
import { createAgentSession, ErrorCode, Invocation } from '../../../index.js';

// Stand-ins for runtime wiring, kept as declarations to keep this example
// type-only.
declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;

// App-specific helper: yields a StorageReader backed by the workflow's
// framework state for the given run, so each hop hydrates the AIT
// session without replaying the channel.
declare const workflowStateReader: (runId: string) => StorageReader;

/**
 * Narrow an unknown caught value to an {@link Ably.ErrorInfo} with the
 * given code. Stands in for a future shared helper; inlined here so
 * examples remain self-contained without new source modules.
 */
const isErrorInfoWithCode = (value: unknown, code: ErrorCode): boolean =>
  value instanceof Ably.ErrorInfo && value.code === code;

/**
 * Hop 1 — plan. Generates a short outline that structures the final
 * answer and publishes it as an assistant turn via {@link step.sendMessages}.
 * The outline lands on the channel and becomes part of the durable
 * conversation, so the next hop — even after a crash and fresh
 * hydration — reads it back via `view.messages`. Clients render the
 * outline as visible progress.
 * @param invocationData - The serialized {@link InvocationData} the client posted.
 * @param options - WDK step context, providing the durable `abortSignal`.
 */
export const planHop = async (
  invocationData: InvocationData,
  { abortSignal: wdkSignal }: { abortSignal: AbortSignal },
): Promise<void> => {
  'use step';

  const invocation = Invocation.fromJSON(invocationData);

  await using session = createAgentSession({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
    storageReader: workflowStateReader(invocation.runId),
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();

  try {
    await step.start({ signal: wdkSignal, timeoutMs: 60_000 });
  } catch (error) {
    if (isErrorInfoWithCode(error, ErrorCode.StepSuperseded)) return;
    throw error;
  }

  try {
    const result = await generateText({
      model: openai('gpt-4o'),
      system:
        "Produce a short bullet-point outline that plans the answer to the user's " +
        'most recent question. Keep it under six bullets. Do not answer the question.',
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.sendMessages({
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [{ type: 'text', text: result.text }],
    });
    await step.end('complete');
  } catch (error) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw error;
  }
};

/**
 * Hop 2 — draft. Streams the final answer to the client, continuing
 * from the plan that hop 1 has now published into the conversation.
 * Reads the outline from `view.messages` (where hop 1's assistant turn
 * has landed — hydrated from the channel via storageReader on fresh
 * start, or from live subscription on a hot resume) rather than taking
 * it as a parameter — one source of truth for the model context.
 * @param invocationData - The serialized {@link InvocationData}.
 * @param options - WDK step context, providing the durable `abortSignal`.
 */
export const draftHop = async (
  invocationData: InvocationData,
  { abortSignal: wdkSignal }: { abortSignal: AbortSignal },
): Promise<void> => {
  'use step';

  const invocation = Invocation.fromJSON(invocationData);

  await using session = createAgentSession({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
    storageReader: workflowStateReader(invocation.runId),
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();

  try {
    await step.start({ signal: wdkSignal, timeoutMs: 60_000 });
  } catch (error) {
    if (isErrorInfoWithCode(error, ErrorCode.StepSuperseded)) return;
    throw error;
  }

  try {
    const result = streamText({
      model: openai('gpt-4o'),
      system:
        'You already outlined your answer in the previous assistant turn. ' +
        "Now write the final answer to the user's most recent question, following that plan.",
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end('complete');
  } catch (error) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw error;
  }
};

/**
 * Close the run once the draft hop has finished. Runs as a writer-only
 * hop: no `connect()`, no tree hydration — the writer publishes
 * `x-ably-run-end` directly (plan §5.7).
 * @param invocationData - The serialized {@link InvocationData} identifying the run to close.
 */
export const endRun = async (invocationData: InvocationData): Promise<void> => {
  'use step';

  const session = createAgentSession({
    client: ably,
    sessionName: invocationData.sessionName,
    codec,
  });
  // No connect() — writer publishes directly to the channel.
  await session.writer.endRun({ runId: invocationData.runId, status: 'complete' });
  await session.close();
};

/**
 * Top-level workflow. Chains the two LLM hops linearly and closes the
 * run on success. If either hop throws, the hop itself has already
 * ended the run terminally before rethrowing, so the workflow only
 * needs to propagate the error.
 * @param invocationData - The serialized {@link InvocationData} from the starting HTTP request.
 */
export const promptChainWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  // Persistent WDK output stream for the run. Exposed so WDK readers
  // (e.g. an API route returning `run.readable`) can follow along.
  getWritable<AI.UIMessageChunk>();

  await planHop(invocationData, { abortSignal: new AbortController().signal });
  await draftHop(invocationData, { abortSignal: new AbortController().signal });
  await endRun(invocationData);
};
