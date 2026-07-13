/**
 * Chat API route — receives the invocation pointer from the client's HTTP POST,
 * streams the AI response back over Ably, and persists each completed run.
 *
 * This is the database-hydration demo: the agent is the sole writer. It
 * hydrates the model context the same way the client does — seeding the prior
 * conversation from the store and reconciling only the live tail from the
 * channel (the seam walk), rather than replaying the whole channel. After the
 * stream finishes, the run's whole turn is appended to the in-memory store
 * (keyed by the channel name) so a later client (or the next run) can seed from
 * it and reconcile with the live channel.
 *
 * The demo exercises tools that suspend and resume the run:
 * - Server-executed tools (getWeather): streamText executes them inline; the
 *   run streams straight through to completion.
 * - Client-executed tools (getLocation): the run suspends after the tool call;
 *   the client runs browser geolocation, publishes the result, and sends a
 *   continuation POST that resumes the same run.
 * - Approval-required tools (getWeatherForecast): the run suspends at
 *   approval-requested; the client publishes a tool-approval-response and the
 *   agent resumes, folding the tool output onto the original assistant message.
 *
 * Because `run.messages` spans the whole suspend/resume run, persisting once at
 * completion (`appendMessages(sessionName, run.messages)`) is lossless — the
 * whole run, tool calls and results included, is stored as one unit. Only a
 * completed run is stored; a still-suspended run stays on the channel until it
 * resumes and completes.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import Ably from 'ably';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { createModel } from './model';
import { tools } from './tools';
import { appendMessages, loadMessages } from '../../lib/message-store';

export async function POST(req: Request) {
  // CAST: trust boundary — the POST body is the client's serialized InvocationData.
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'ABLY_API_KEY not set' }, { status: 500 });
  }

  // A fresh Ably client per request. `ABLY_ENDPOINT` lets the e2e tests point
  // the agent at the Ably sandbox (`nonprod:sandbox`); unset in normal use, so
  // it defaults to production.
  const ably = new Ably.Realtime({
    key: apiKey,
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  // Hydrate the model context the way the client does (see useMessagesWithSeed):
  // seed the prior conversation from the store and reconcile only the live tail
  // from the channel, rather than replaying the whole channel. The store holds
  // every completed run, so the newest stored message is the seam.
  //
  // loadUntil pages run.view back to the seam and returns only the messages newer
  // than it — the not-yet-stored tail (here, this invocation's new input). It
  // drives the paging itself, which also folds in this invocation's triggering
  // input — published before this per-request agent attached, so it lives in
  // channel history, not the live (post-attach) window. run.start() then proceeds
  // once that input has been located. With no stored history (no seam) the
  // predicate never matches, so loadUntil hydrates the whole channel.
  //
  // The database read (this demo's in-memory message-store stands in for it).
  const seed = loadMessages(invocation.sessionName);
  const seamId = seed.at(-1)?.id;
  await run.view.loadUntil((m) => m.message.id === seamId);
  await run.start();

  after(async () => {
    // Steering loop. `run.hasInput()` is a delta predicate:
    //   - returns true on the first call (the trigger input is pending),
    //   - returns true again whenever a steering message has folded into the
    //     run since the previous call (the user typed `/steer ...` while we
    //     were streaming),
    //   - returns false only when nothing new has arrived since the previous
    //     call AND the trigger has been processed at least once.
    // Each iteration recomposes the model context from the seed plus
    // `run.view.getMessages()` — after the seam walk that view holds exactly
    // the not-yet-stored tail, and it grows as steering messages fold in, so
    // each steering message is included in the next inference pass. A suspend /
    // cancel / error outcome breaks the loop.
    let outcome: Awaited<ReturnType<typeof vercelRunOutcome>> | undefined;
    while (run.hasInput()) {
      const conversation = [...seed, ...run.view.getMessages().map((m) => m.message)];
      const result = streamText({
        model: createModel(),
        system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
        messages: await convertToModelMessages(conversation),
        tools,
        abortSignal: run.abortSignal,
        // Multi-step: streamText loops inference + server-tool execution within
        // this call so server-executed tools (getWeather, approved
        // getWeatherForecast) chain straight into the model's next inference pass
        // and produce the final response. Client-executed tools (getLocation) and
        // approval-requested tools still pause this call naturally — streamText
        // finishes that step with `finishReason: 'tool-calls'`, the run suspends,
        // and the client publishes a continuation.
        stopWhen: stepCountIs(10),
      });
      const pipeResult = await run.pipe(result.toUIMessageStream());
      outcome = await vercelRunOutcome(pipeResult, result.finishReason);
      // Exit on any non-complete outcome (suspend / cancel / error). On a
      // `complete` outcome we re-check `hasInput()` at the top: a steering
      // message that arrived during this iteration makes it true again and
      // drives another inference pass that includes it in the conversation.
      if (outcome.reason !== 'complete') break;
    }

    const finalOutcome = outcome ?? { reason: 'complete' as const };
    if (finalOutcome.reason === 'suspend') {
      // The run paused for a client-executed or approval-gated tool. Suspend
      // it (publishing the suspend signal); the client resolves the tool and
      // sends a continuation that resumes this run. A suspended run is never
      // persisted — only the completed whole-run turn is.
      await run.suspend();
    } else {
      // End the run first, then persist. run.end publishes the completion
      // signal, so it shouldn't wait on (or fail with) the database write. The
      // run's content is already on the channel (from run.pipe above), and both
      // a reloading client and the agent's next run reconcile the stored seed
      // with the live channel — so a run the store hasn't caught up on yet is
      // still read from the channel, never dropped. Keyed by domain id, so
      // idempotent; only completed runs are stored (cancelled/errored partials
      // stay on the channel via run-end).
      const runMessages = run.messages;
      await run.end(finalOutcome);
      // The database write: persist the completed run's messages (the in-memory
      // message-store stands in for a durable store).
      if (finalOutcome.reason === 'complete') await appendMessages(invocation.sessionName, runMessages);
    }
    await session.end();
    ably.close();
  });

  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
