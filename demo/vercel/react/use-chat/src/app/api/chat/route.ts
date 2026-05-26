/**
 * Chat API route — receives messages from the client session's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Supports three tool execution patterns:
 * - Server-executed tools (getWeather): streamText runs them inline.
 * - Client-executed tools (getLocation): the client suspends the run after
 *   the tool call, executes the tool, then sends a continuation invocation
 *   under the same runId. The SDK overlays the client-published tool output
 *   onto the suspended assistant before `run.messages` is read.
 * - Server-executed gated on approval (getWeatherForecast): suspends at
 *   `approval-requested`. The user approves → the client publishes a
 *   `tool-approval-response` TEvent on the channel → continuation POST →
 *   `run.messages` reflects the approval. The tool's `needsApproval`
 *   returns `false` once the matching `toolCallId` has an
 *   `approval-responded` part in the messages, so `streamText` executes
 *   it without re-pausing. `run.pipe`'s internal `resolveToolTarget`
 *   redirects the resulting tool-output wire message back to the original
 *   assistant message via `HEADER_CODEC_MESSAGE_ID`.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import type { UIMessage } from 'ai';
import Ably from 'ably';
import { createAgentSession, vercelRunEndReason } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { createModel } from './model';
import { tools } from './tools';

// Server-side Ably client — uses API key directly (trusted environment).
const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const data = (await req.json()) as InvocationData<UIMessage>;
  const invocation = Invocation.fromJSON(data);

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();

  const result = streamText({
    model: createModel(),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(run.messages),
    tools,
    abortSignal: run.abortSignal,
    stopWhen: stepCountIs(10),
  });

  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream());
    const endReason = await vercelRunEndReason(pipeResult, result.finishReason);
    await run.end(endReason);
    session.close();
  });

  return new Response(null, { status: 200 });
}
