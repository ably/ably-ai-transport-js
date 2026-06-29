/**
 * Chat API route — receives the invocation pointer from the client's HTTP POST,
 * streams the AI response back over Ably, and persists each completed turn.
 *
 * This is the database-hydration demo: the agent is the sole writer. It
 * hydrates the model context the same way the client does — seeding the prior
 * conversation from the store and reconciling only the live tail from the
 * channel (the seam walk), rather than replaying the whole channel. After the
 * stream finishes, the run's whole turn is appended to the in-memory store
 * (keyed by the channel name) so a later client (or the next run) can seed from
 * it and reconcile with the live channel. The demo is text-only — no tools — so
 * a run always runs to completion rather than suspending for a tool or approval.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import Ably from 'ably';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { createModel } from './model';
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
  // every completed turn, so the newest stored message is the seam.
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
    system: 'You are a helpful assistant. Reply concisely.',
    messages: await convertToModelMessages(conversation),
    abortSignal: run.abortSignal,
  });

  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream());
    const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    if (outcome.reason === 'suspend') {
      // Text-only (no tools), so a run never actually suspends — handled for
      // type completeness; a suspended run is never persisted.
      await run.suspend();
    } else {
      // End the run first, then persist. run.end publishes the completion
      // signal, so it shouldn't wait on (or fail with) the database write. The
      // turn's content is already on the channel (from run.pipe above), and both
      // a reloading client and the agent's next run reconcile the stored seed
      // with the live channel — so a turn the store hasn't caught up on yet is
      // still read from the channel, never dropped. Keyed by domain id, so
      // idempotent; only completed turns are stored (cancelled/errored partials
      // stay on the channel via run-end).
      const turn = run.messages;
      await run.end(outcome);
      // The database write: persist the completed turn (the in-memory
      // message-store stands in for a durable store).
      if (outcome.reason === 'complete') await appendMessages(invocation.sessionName, turn);
    }
    await session.close();
    ably.close();
  });

  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
