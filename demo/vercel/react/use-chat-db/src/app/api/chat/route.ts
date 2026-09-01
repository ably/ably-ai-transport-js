/**
 * Chat API route — the agent side, built on the standalone
 * `createAgentTransport`.
 *
 * The client's HTTP POST names the channel and the `event-id` of the input
 * that woke this invocation. The route:
 *
 * 1. Locates the triggering input in channel history (`locateInput`).
 * 2. Assembles the model context by folding the whole channel history —
 *    bounded at the attach point, which is after the trigger was published
 *    since the agent connects per-POST — through the same fold helper the
 *    client hydrates with (`lib/fold-messages.ts`).
 * 3. Opens a run anchored to that input, answers 202, and pipes the
 *    `streamText` output to the channel in `after()`. Every start chunk names
 *    a `messageId`, so the client, the store, and the fold agree on each
 *    assistant message's domain id.
 * 4. Ends the run from the `vercelRunOutcome` of the pipe.
 *
 * Tool patterns: server-executed tools (getWeather) run inline; a
 * client-executed tool (getLocation, no `execute`) or an approval-gated tool
 * (getWeatherForecast, `needsApproval`) leaves the finish reason at
 * `tool-calls`. That turn still ends: the useChat adapter publishes each
 * resolution as a plain input carrying no run id, so the continuation POST
 * opens a fresh run. On it, the folded history carries the tool output (a
 * `{ kind: 'chunk' }` input) or the approval decision (the
 * `{ kind: 'approval' }` body, flipped onto the tool part by the fold), so
 * `streamText` executes the approved tool and answers.
 *
 * Persistence is client-owned in this demo: the sender POSTs each completed
 * turn to `/api/messages` from useChat's `onFinish`.
 */

import { after } from 'next/server';
import { convertToModelMessages, stepCountIs, streamText, toUIMessageStream } from 'ai';
import Ably from 'ably';
import { channelAgent } from '@ably/ai-transport';
import { createAgentTransport, vercelRunOutcome } from '@ably/ai-transport/vercel';
import { createModel } from './model';
import { tools } from './tools';
import { type ChatTransportEvent, foldMessages } from '../../lib/fold-messages';

/** The invocation pointer the SDK's chat transport POSTs. */
interface ChatRequestBody {
  /** The conversation's channel name. */
  channelName: string;
  /** The `event-id` of the published input that woke this invocation. */
  eventId: string;
}

export async function POST(req: Request) {
  // CAST: trust boundary — the POST body is the chat transport's invocation pointer.
  const body = (await req.json()) as ChatRequestBody;
  const { channelName, eventId } = body;
  if (typeof channelName !== 'string' || typeof eventId !== 'string') {
    return Response.json({ error: 'channelName and eventId are required' }, { status: 400 });
  }

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

  const channel = ably.channels.get(channelName, { params: { agent: channelAgent() } });
  const transport = createAgentTransport({ channel });
  await transport.connect();

  const located = await transport.locateInput(eventId);
  if (!located) {
    transport.close();
    ably.close();
    return Response.json({ error: `input ${eventId} not found in channel history` }, { status: 404 });
  }

  // Model context: fold the whole channel history. Everything the model needs
  // is on the channel — prior turns, the triggering input, and (on a
  // continuation) the earlier turn that asked for the tool, with its
  // resolution or approval decision.
  const events: ChatTransportEvent[] = [];
  for (;;) {
    const batch = await transport.history();
    events.unshift(...batch.events);
    if (batch.exhausted) break;
  }
  const conversation = (await foldMessages(events)).map((entry) => entry.message);

  // Opening from the located input anchors the run to its trigger, which is
  // what lets the client resolve the run id off the channel and lets a cancel
  // route back to this run. Every input the useChat adapter publishes carries
  // no run id, so each one opens a fresh run.
  const run = transport.openRun({ input: located }, { signal: req.signal });

  const result = streamText({
    model: createModel(),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(conversation),
    tools,
    abortSignal: run.abortSignal,
    stopWhen: stepCountIs(10),
  });

  after(async () => {
    try {
      // `generateMessageId` puts a domain id on the stream's `start` chunk, so
      // the id useChat renders, the id the client persists, and the id the
      // hydration fold reconstructs are all the same.
      const pipeResult = await run.pipe(
        toUIMessageStream({ stream: result.fullStream, generateMessageId: () => crypto.randomUUID() }),
      );
      const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
      // A turn that stopped on tool calls is still terminal: the client's
      // resolution wakes a new run rather than resuming this one.
      await run.end(outcome.reason === 'suspend' ? { reason: 'complete' } : outcome);
    } finally {
      transport.close();
      ably.close();
    }
  });

  // The POST only wakes the agent. The adapter resolves the run id off the
  // channel, matching the `ai-run-start` that names the input it published.
  return new Response('', { status: 202 });
}
