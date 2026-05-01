/**
 * Temporal activities. Activities run in regular Node.js context (unlike
 * workflows) so they can hold open connections — here we reuse a cached
 * {@link AgentSession} for each Ably session name and drive the streaming
 * exchange end-to-end.
 *
 * `runAgentTurn` mirrors the Vercel demo's `/api/agent` handler body:
 * bind a run to the invocation, open a step, pipe the model's UI message
 * stream through it, and end the run.
 */

import { Context } from '@temporalio/activity';
import { anthropic } from '@ai-sdk/anthropic';
import { convertToModelMessages, jsonSchema, stepCountIs, streamText, tool } from 'ai';

import { Invocation, type InvocationData } from '@ably/ai-transport';

import { getSession } from '../lib/agent-session';

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';

// Demo tool — fake weather lookup. Returns deterministic data so the demo
// runs without hitting an external API. The model decides when to call it
// based on the user's prompt; the AI SDK executes the `execute` function
// and emits `tool-input-*` / `tool-output-*` chunks that the codec
// transports to subscribers.
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

export async function runAgentTurn(data: InvocationData): Promise<void> {
  const invocation = Invocation.fromJSON(data);
  const session = await getSession(invocation.sessionName);
  const signal = Context.current().cancellationSignal;

  await using run = await session.createRun(invocation, { signal });
  await using step = run.createStep();
  await step.start({ signal, timeoutMs: 60_000 });

  try {
    const messages = await convertToModelMessages(run.view.messages.map((node) => node.message));
    const result = streamText({
      model: anthropic(MODEL),
      messages,
      abortSignal: step.signal,
      tools: { getWeather },
      // streamText's default `stopWhen` is `stepCountIs(1)`, which stops
      // after the first model call — meaning the model emits the tool
      // call, the SDK runs the tool, and the stream ends with no final
      // assistant text. Bump to 5 so the model gets a chance to use the
      // tool result to compose a reply.
      stopWhen: stepCountIs(5),
    });
    await step.pipe(result.toUIMessageStream());
    await step.end();
    await run.end();
  } catch (error) {
    await step.end(error);
    await run.end(error);
    if (!step.signal.aborted) throw error;
  }
}
