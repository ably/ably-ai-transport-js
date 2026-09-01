/**
 * Chat API route — the agent side, built on the standalone
 * `createAgentTransport`.
 *
 * The client's HTTP POST names the channel and the `event-id` of the input
 * that woke this invocation. The route:
 *
 * 1. Locates the triggering input in channel history (`locateInput`).
 * 2. Assembles the model context by merging the whole channel history —
 *    bounded at the attach point, which is after the trigger was published
 *    since the agent connects per-POST — through the same merge helper the
 *    client hydrates with (`lib/merge-messages.ts`).
 * 3. Opens a run anchored to that input, answers 202, and pipes the
 *    `streamText` output to the channel in `after()`. Every start chunk names
 *    a `messageId`, so the client, the store, and the merge agree on each
 *    assistant message's domain id.
 * 4. Ends the run from the `vercelRunOutcome` of the pipe.
 *
 * Tool patterns: server-executed tools (getWeather) run inline; a
 * client-executed tool (getLocation, no `execute`) or an approval-gated tool
 * (getWeatherForecast, `needsApproval`) leaves the finish reason at
 * `tool-calls`. That turn still ends: the useChat adapter publishes each
 * resolution as a plain input carrying no run id, so the continuation POST
 * opens a fresh run. On it, the merged history carries the tool output (a
 * `{ kind: 'chunk' }` input) or the approval decision (the
 * `{ kind: 'approval' }` body, flipped onto the tool part by the merge), so
 * `streamText` executes the approved tool and answers.
 *
 * Persistence is client-owned in this demo: the sender POSTs each completed
 * turn to `/api/messages` from useChat's `onFinish`.
 */

import { after } from 'next/server';
import { convertToModelMessages, stepCountIs, streamText, toUIMessageStream } from 'ai';
import Ably from 'ably';
import { channelAgent, ErrorCode } from '@ably/ai-transport';
import { createAgentTransport, vercelRunOutcome } from '@ably/ai-transport/vercel';
import { createModel } from './model';
import { tools } from './tools';
import { type ChatTransportEvent, mergeMessages } from '../../lib/merge-messages';

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
  const close = (): void => {
    transport.close();
    ably.close();
  };

  let run;
  let result;
  try {
    await transport.connect();

    const located = await transport.locateInput(eventId);
    if (!located) {
      close();
      return Response.json({ error: `input ${eventId} not found in channel history` }, { status: 404 });
    }

    // Model context: merge the whole channel history. Everything the model needs
    // is on the channel — prior turns, the triggering input, and (on a
    // continuation) the earlier turn that asked for the tool, with its
    // resolution or approval decision.
    const events: ChatTransportEvent[] = [];
    for (;;) {
      const batch = await transport.history();
      events.unshift(...batch.events);
      if (batch.exhausted) break;
    }
    const conversation = (await mergeMessages(events)).map((entry) => entry.message);

    // Opening from the located input anchors the run to its trigger, which is
    // what lets the client resolve the run id off the channel and lets a cancel
    // route back to this run. Every input the useChat adapter publishes carries
    // no run id, so each one opens a fresh run.
    run = transport.openRun({ input: located }, { signal: req.signal });

    result = streamText({
      model: createModel(),
      system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
      messages: await convertToModelMessages(conversation),
      tools,
      abortSignal: run.abortSignal,
      stopWhen: stepCountIs(10),
    });
  } catch (error) {
    // Nothing has streamed yet, but the Ably connection is open and the run
    // may be too — leaving either would hang the client's stream for good.
    if (run) {
      const message = error instanceof Error ? error.message : String(error);
      await run.end({
        reason: 'error',
        error: new Ably.ErrorInfo(`unable to start run; ${message}`, ErrorCode.RunResponseStreamFailed, 500),
      });
    }
    close();
    throw error;
  }

  const openedRun = run;
  const streamResult = result;

  after(async () => {
    try {
      // `generateMessageId` puts a domain id on the stream's `start` chunk, so
      // the id useChat renders, the id the client persists, and the id the
      // hydration merge reconstructs are all the same.
      const pipeResult = await openedRun.pipe(
        toUIMessageStream({ stream: streamResult.fullStream, generateMessageId: () => crypto.randomUUID() }),
      );
      const outcome = await vercelRunOutcome(pipeResult, streamResult.finishReason);
      // A turn that stopped on tool calls is still terminal: the client's
      // resolution wakes a new run rather than resuming this one.
      await openedRun.end(outcome.reason === 'suspend' ? { reason: 'complete' } : outcome);
    } catch (error) {
      // The run is open on the channel; end it so clients are not left
      // waiting on a stream that never closes.
      const message = error instanceof Error ? error.message : String(error);
      await openedRun.end({
        reason: 'error',
        error: new Ably.ErrorInfo(`unable to complete run; ${message}`, ErrorCode.RunResponseStreamFailed, 500),
      });
    } finally {
      close();
    }
  });

  // The POST only wakes the agent. The adapter resolves the run id off the
  // channel, matching the `ai-run-start` that names the input it published.
  return new Response('', { status: 202 });
}
