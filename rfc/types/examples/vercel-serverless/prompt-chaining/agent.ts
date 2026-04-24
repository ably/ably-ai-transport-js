/**
 * Prompt-chaining workflow — serverless agent side.
 *
 * Pattern per Anthropic, "Building Effective Agents"
 * (https://www.anthropic.com/engineering/building-effective-agents):
 * decompose a task into a fixed sequence of LLM calls where each step
 * consumes the previous step's output. No loops, no dynamic routing —
 * the code owns the workflow shape; each step is an LLM call bounded
 * by the transport's Step primitive.
 *
 * Two steps here:
 *   1. plan  — produces a short outline that structures the answer
 *              and publishes it to the channel as an assistant turn
 *              so clients can render the plan as visible progress
 *              and step 2 can read it back via run.view.messages.
 *   2. draft — streams the final answer to the client, continuing
 *              from the plan that's now in the conversation.
 *
 * Runs in a single serverless function invocation on one session and
 * one run. Multi-step-per-run lets the handler express the chain
 * without tearing down and re-opening transport state between steps;
 * each step still publishes its own x-ably-step-start / x-ably-step-end
 * so that abort routing, pause handling, and observer progress are
 * granular per-step.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, generateText, streamText } from 'ai';

import type { AgentRun, Codec, InvocationData } from '../../../index.js';
import { createAgentSession, Invocation } from '../../../index.js';

// Stand-ins for runtime wiring, kept as declarations to keep this example
// type-only.
declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;

/**
 * Agent HTTP handler. Reads an invocation from the body and runs the
 * plan → draft chain to completion.
 * @param req - The incoming HTTP request whose body is an {@link InvocationData}.
 * @returns A 202 response once the run has closed.
 */
export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  await using session = createAgentSession({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
  });
  await session.connect();

  await using run = session.createRun(invocation);

  try {
    await planStep(run, req.signal);
    await draftStep(run, req.signal);
    await run.end('complete');
  } catch (error) {
    await run.end(req.signal.aborted ? 'aborted' : 'failed');
    throw error;
  }

  return new Response(undefined, { status: 202 });
};

/**
 * Step 1 — plan. Generates a short outline that structures the final
 * answer and publishes it as an assistant turn via {@link step.sendMessages}.
 * Clients render the outline as visible progress, and step 2 picks it up
 * naturally via `run.view.messages` — no out-of-band parameter passing.
 * @param run - The agent run for this invocation.
 * @param reqSignal - The request signal, folded into step.signal via start().
 */
const planStep = async (
  run: AgentRun<Codec<AI.UIMessageChunk, AI.UIMessage>>,
  reqSignal: AbortSignal,
): Promise<void> => {
  await using step = run.createStep();
  await step.start({ signal: reqSignal, timeoutMs: 60_000 });

  const result = await generateText({
    model: openai('gpt-4o'),
    system:
      "Produce a short bullet-point outline that plans the answer to the user's " +
      'most recent question. Keep it under six bullets. Do not answer the question.',
    messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
    abortSignal: step.signal,
  });

  await step.sendMessages({
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [{ type: 'text', text: result.text }],
  });
  await step.end('complete');
};

/**
 * Step 2 — draft. Streams the final answer to the client, continuing
 * from the plan that step 1 has now published into the conversation.
 * Reads the outline from `run.view.messages` (where step 1's assistant
 * turn has landed) rather than taking it as a parameter — one source of
 * truth for the model context. The step pipes the model's UI-message
 * stream to the channel; clients see incremental tokens land in the
 * same run, tagged with this step's ID.
 * @param run - The agent run for this invocation.
 * @param reqSignal - The request signal, folded into step.signal via start().
 */
const draftStep = async (
  run: AgentRun<Codec<AI.UIMessageChunk, AI.UIMessage>>,
  reqSignal: AbortSignal,
): Promise<void> => {
  await using step = run.createStep();
  await step.start({ signal: reqSignal, timeoutMs: 60_000 });

  const result = streamText({
    model: openai('gpt-4o'),
    system:
      'You already outlined your answer in the previous assistant turn. ' +
      "Now write the final answer to the user's most recent question, following that plan.",
    messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
    abortSignal: step.signal,
  });

  await step.pipe(result.toUIMessageStream());
  await step.end('complete');
};
