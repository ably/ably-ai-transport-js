/**
 * Chat API route — receives messages from the client session's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Continuation handling is entirely inside the SDK: `run.messages` returns
 * the LLM-ready conversation history, with any client-published tool
 * resolutions (output / approval) already overlaid onto the assistant
 * messages they belong to. No `loadProjection` / overlay code here.
 *
 * - Server-executed tools (getWeather): streamText handles execution inline.
 * - Client-executed tools (getLocation): client suspends after the tool call,
 *   publishes a `tool-output-available` chunk on the channel, then sends
 *   a continuation POST. The SDK overlays the tool result onto the suspended
 *   assistant before `run.messages` is read.
 * - Approval-required tools (getWeatherForecast): client publishes a
 *   `tool-approval-response` TEvent on Approve. The SDK overlays the
 *   `approval-responded` state. The tool's `needsApproval` returns false
 *   on the second pass, so streamText executes without re-pausing.
 *   `Run.pipe`'s `resolveToolTarget` hook redirects the resulting tool
 *   output back to the original assistant.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import Ably from 'ably';
import { createAgentSession, vercelRunEndReason } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { createModel } from './model';
import { tools } from './tools';

export async function POST(req: Request) {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  // A fresh Ably client per request. The agent is ephemeral: it attaches the
  // channel with rewind, replays the just-published input event, streams the
  // response, and closes. A client shared across requests would keep the
  // channel attached, so a later request would NOT re-attach with rewind and
  // would miss inputs published while no agent was subscribed (the second
  // message's input-event lookup would time out). A per-request client also
  // keeps concurrent runs on the same channel from detaching each other.
  const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();
  await run.loadConversation();

  const result = streamText({
    model: createModel(),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(run.messages),
    tools,
    abortSignal: run.abortSignal,
    // Multi-step: streamText loops inference + server-tool execution within
    // this call so server-executed tools (getWeather, approved
    // getWeatherForecast) chain straight into the model's next inference
    // pass and produce the final response. Without this the run would
    // suspend after each server tool, leading to empty-events
    // continuations that violate the SDK's "every send carries ≥1
    // prompt-bearing event" invariant. Client-executed tools (getLocation)
    // and approval-requested tools still pause this call naturally —
    // streamText finishes that step with `finishReason: 'tool-calls'`,
    // the run suspends, and the client publishes a continuation.
    stopWhen: stepCountIs(10),
  });

  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream());
    const endReason = await vercelRunEndReason(pipeResult, result.finishReason);
    await run.end(endReason);
    session.close();
    ably.close();
  });

  // Return the invocation id the agent minted (or echoed, when the client
  // supplied one) so the caller can correlate this run out-of-band. The
  // response stream itself arrives over Ably, not in this HTTP response.
  return Response.json({ invocationId: invocation.invocationId });
}
