/**
 * Chat API route — receives messages from the client session's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Continuation handling is entirely inside the SDK: `run.loadConversation()`
 * returns the LLM-ready conversation history, with any client-published tool
 * resolutions (output / approval) already overlaid onto the assistant
 * messages they belong to. No `loadProjection` / overlay code here.
 *
 * - Server-executed tools (getWeather): streamText handles execution inline.
 * - Client-executed tools (getLocation): client suspends after the tool call,
 *   publishes a `tool-output-available` chunk on the channel, then sends
 *   a continuation POST. The SDK overlays the tool result onto the suspended
 *   assistant before the conversation is read.
 * - Approval-required tools (getWeatherForecast): client publishes a
 *   `tool-approval-response` TEvent on Approve. The SDK overlays the
 *   `approval-responded` state. The tool's `needsApproval` returns false
 *   on the second pass, so streamText executes without re-pausing. The
 *   codec reducer folds the resulting tool output onto the original
 *   assistant by matching its `toolCallId`.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import Ably from 'ably';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { createModel } from './model';
import { tools } from './tools';

export async function POST(req: Request) {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  // A fresh Ably client per request. The agent is ephemeral: it attaches the
  // channel, looks up the triggering input event via `untilAttach: true`
  // history, streams the response, and closes. A per-request client keeps
  // concurrent runs on the same channel from detaching each other.
  // `ABLY_ENDPOINT` lets the e2e tests point the agent at the Ably sandbox
  // (`nonprod:sandbox`); unset in normal use, so it defaults to production.
  const ably = new Ably.Realtime({
    key: process.env.ABLY_API_KEY!,
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();

  after(async () => {
    // Steering loop. `run.hasInput()` is a delta predicate:
    //   - returns true on the first call (the trigger input is pending),
    //   - returns true again whenever a new steering message has folded
    //     into the Run since the previous call (the user typed `/steer ...`
    //     while we were streaming),
    //   - returns false only when nothing new has arrived since the previous
    //     call AND the trigger has been processed at least once.
    //
    // Each iteration reads `run.messages` LIVE — so any steering message
    // that folded into the Run is included in the LLM context for the next
    // inference pass. The SDK captures the channel cutoff at the moment
    // hasInput() returns false; that becomes `input-hwm-serial` on the run's
    // terminal lifecycle event, letting the client tell whether each steer
    // was consumed.
    //
    // Suspension breaks out of the loop: a tool-result / approval-required
    // step ends the run-iteration as `suspend`, and the next invocation
    // will resume the run via `ai-run-resume`.
    let lastOutcome: Awaited<ReturnType<typeof vercelRunOutcome>> | undefined;
    while (run.hasInput()) {
      // Re-load the un-paginated conversation each iteration so any steering
      // message folded into the Tree since the previous pipe is included in
      // the model's context. `run.messages` is only this run's own turn.
      const conversation = await run.loadConversation();
      const result = streamText({
        model: createModel(),
        system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
        messages: await convertToModelMessages(conversation),
        tools,
        abortSignal: run.abortSignal,
        // Multi-step: streamText loops inference + server-tool execution
        // within this call so server-executed tools (getWeather, approved
        // getWeatherForecast) chain straight into the model's next inference
        // pass and produce the final response. Without this the run would
        // suspend after each server tool, leading to empty-events
        // continuations that violate the SDK's "every send carries ≥1
        // prompt-bearing event" invariant. Client-executed tools
        // (getLocation) and approval-requested tools still pause this call
        // naturally — streamText finishes that step with
        // `finishReason: 'tool-calls'`, the run suspends, and the client
        // publishes a continuation.
        stopWhen: stepCountIs(10),
      });
      const pipeResult = await run.pipe(result.toUIMessageStream());
      lastOutcome = await vercelRunOutcome(pipeResult, result.finishReason);
      // Exit the loop on any non-complete outcome (suspend / cancel / error).
      // For a `complete` outcome we re-check `hasInput()` at the top: if a
      // steering message arrived during this iteration it will return true
      // again and we run another inference pass that includes the steer in
      // run.messages.
      if (lastOutcome.reason !== 'complete') break;
    }

    // Resolve the terminal lifecycle. If `hasInput()` returned false with no
    // pipe ever happening (no triggering input visible), default to
    // complete to avoid leaving the run open.
    const finalOutcome = lastOutcome ?? { reason: 'complete' as const };
    if (finalOutcome.reason === 'suspend') {
      await run.suspend();
    } else {
      // We choose to forward the run's terminal error so clients can show
      // why the run failed; a server could omit it to avoid exposing
      // internal failure detail.
      await run.end(finalOutcome);
    }
    await session.close();
    ably.close();
  });

  // Return the agent-minted ids on the HTTP response. The agent now mints both
  // the run-id (when the invocation omits it for a fresh run) and the
  // invocation-id; the client reads them back from here.
  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
