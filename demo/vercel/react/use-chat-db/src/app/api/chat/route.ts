/**
 * Chat API route — receives the invocation pointer from the client's HTTP POST,
 * streams the AI response back over Ably, and persists each completed run.
 *
 * This is the database-hydration demo: the agent is the sole writer. It
 * hydrates the model context the same way the client does — seeding the prior
 * conversation from the store and reconciling only the live tail from the
 * channel (the seam walk), rather than replaying the whole channel.
 *
 * It supports the same tool patterns as the sibling `use-chat` demo:
 * - Server-executed tools (getWeather): streamText runs them inline.
 * - Client-executed tools (getLocation): the run SUSPENDS after the tool call;
 *   the client executes the tool and sends a continuation under the same runId,
 *   which resumes the run. `run.messages` spans the whole suspend/resume run, so
 *   a single persist at completion captures the input, the tool call, and the
 *   final answer with no loss.
 * - Approval-gated tools (getWeatherForecast): the run SUSPENDS at
 *   `approval-requested`; the user approves, a continuation resumes the run, and
 *   the tool-call message stays mutable (shown as approved) after hydration.
 *
 * A suspended run is never persisted — only the terminal (complete) run is
 * appended to the in-memory store (keyed by the channel name), so a later client
 * (or the next run) can seed from it and reconcile with the live channel.
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

  // A fresh Ably client per request (trusted environment, API key direct).
  // `ABLY_ENDPOINT` lets the e2e tests point the agent at the Ably sandbox
  // (`nonprod:sandbox`); unset in normal use, so it defaults to production.
  const ably = new Ably.Realtime({
    key: apiKey,
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  // No identity is pinned: this run is not retried, so a generated run-id and
  // invocation-id are correct.
  const run = session.createRun(invocation, {}, { signal: req.signal });

  // Hydrate the model context the way the client does (see useMessageSync, which
  // this demo's client uses to seed useChat): seed the prior conversation from
  // the store and reconcile only the live tail from the channel, rather than
  // replaying the whole channel. The store holds every completed run, so the
  // newest stored message is the seam.
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
  const tail = await run.view.loadUntil((m) => m.message.id === seamId);
  await run.start();

  const conversation = [...seed, ...tail.map((m) => m.message)];

  const result = streamText({
    model: createModel(),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(conversation),
    tools,
    abortSignal: run.abortSignal,
    stopWhen: stepCountIs(10),
  });

  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream());
    const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    if (outcome.reason === 'suspend') {
      // A client-executed or approval-gated tool suspends the run; the client
      // resumes it with a continuation under the same runId. A suspended run is
      // never persisted — only the terminal (complete) run is.
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
      await run.end(outcome);
      // The database write: persist the completed run's messages (the in-memory
      // message-store stands in for a durable store).
      if (outcome.reason === 'complete') await appendMessages(invocation.sessionName, runMessages);
    }
    await session.end();
    ably.close();
  });

  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
