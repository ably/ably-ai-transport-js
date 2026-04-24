/**
 * Basic chat — serverless agent side.
 *
 * One run, one step. A `ToolLoopAgent` executes the full tool-calling loop
 * inline within a single HTTP invocation; the step bookends the whole loop
 * with one `x-ably-step-start` / `x-ably-step-end`. Works identically when
 * the tool set is empty (a plain chat response) or rich (multi-hop tool use).
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs, ToolLoopAgent } from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createAgentSession, Invocation } from '../../../index.js';

// Stand-ins for runtime wiring, kept as declarations to keep this example
// type-only.
declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;
declare const tools: AI.ToolSet;

const agent = new ToolLoopAgent({
  model: openai('gpt-4o'),
  tools,
  stopWhen: stepCountIs(20),
});

/**
 * Agent HTTP handler. Reads an invocation from the body and runs the
 * agent loop to a terminal response.
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
  await using step = run.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  try {
    const result = await agent.stream({
      messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end('complete');
    await run.end('complete');
  } catch (error) {
    await run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw error;
  }

  return new Response(undefined, { status: 202 });
};
