/**
 * Chat API route — woken by the client's HTTP POST, runs the OpenAI Responses
 * model, and streams the reply back over Ably.
 *
 * Uses the generic, codec-agnostic agent transport (`createAgentTransport`
 * from `@ably/ai-transport`) parameterized by the demo's typed Responses codec instance;
 * there is no OpenAI-specific transport layer. The wake body carries the
 * channel name and the triggering input's `eventId` (matched on the channel
 * via `locateInput`). No input carries a run-id, so every open is a fresh
 * `ai-run-start` — a tool answer opens a new run rather than resuming the one
 * that asked. The conversation for the model comes from the store plus that
 * one input (`lib/conversation.ts`), flattened into the `/responses` `input`
 * array by `toResponsesInput`. **No channel history is paged**, here or in the
 * client: the store is the conversation, and the input `locateInput` returns
 * is everything that has happened since the last write.
 *
 * The route owns both writes to the store (`lib/message-store.ts`), which
 * clients hydrate from over `GET /api/messages` — a read that touches no Ably
 * connection. The prompt lands as the run opens, so a page loading mid-run
 * sees what started the reply it is watching; the assistant's messages land
 * when the run is over, built from what the run itself published rather than
 * from anything read back.
 *
 * Tools run inside the agentic loop (`runAgentLoop`). A server-executed tool
 * keeps the run going — the loop runs it, publishes its
 * `function_call_output`, and continues `/responses` until the model produces a
 * final reply. A client-executed or approval-gated tool ends it: there is
 * nothing more this process can do, and the resolution the client publishes
 * wakes a NEW run that answers. Nothing suspends and nothing resumes, which is
 * one less state for a hydrating client to reason about. The loop publishes
 * each unit of work under its own `run.pipe`, so a run that calls a tool
 * produces several messages (the model turn, the tool outputs, the final turn).
 * Each pipe's stream goes to the run as-is: the codec's descriptor table
 * curates the wire, dropping the framing events no consumer reads and throwing
 * on any genuinely unexpected event.
 *
 * Run outcome: `runAgentLoop` returns a `RunEndParams`, forwarded to
 * `run.end()` directly (the error arm already carrying the wrapped
 * `Ably.ErrorInfo`). A cancel — a client cancel or a request abort — overrides
 * it and ends the run `cancelled`.
 */

import { after } from 'next/server';
import Ably from 'ably';
import { channelAgent, createAgentTransport } from '@ably/ai-transport';

import { responsesCodec, toResponsesInput } from '../../lib/openai-thread';

import { openConversation } from '../../lib/conversation';
import { runAgentLoop } from './agent-stream';

/** The wake body the demo's client POSTs (see `wakeAgent` in `src/app/helpers.ts`). */
interface ChatRequestBody {
  /** The Ably channel the conversation lives on. */
  channelName: string;
  /** The triggering input's `event-id`, matched on the channel via `locateInput`. */
  eventId: string;
}

export async function POST(req: Request) {
  // CAST: trust boundary — the demo's own client POSTs this shape.
  const body = (await req.json()) as ChatRequestBody;
  const { channelName } = body;
  if (typeof body.channelName !== 'string' || typeof body.eventId !== 'string') {
    return Response.json({ error: 'channelName and eventId are required' }, { status: 400 });
  }

  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'ABLY_API_KEY not set' }, { status: 500 });
  }

  // A fresh Ably client per request. The agent is ephemeral: it attaches the
  // channel, looks up the triggering input event, streams the response, and
  // closes. A per-request client keeps concurrent runs on the same channel from
  // detaching each other. `ABLY_ENDPOINT` lets the e2e tests point the agent at
  // the Ably sandbox (`nonprod:sandbox`); unset in normal use, so it defaults
  // to production.
  const ably = new Ably.Realtime({
    key: apiKey,
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });

  const channel = ably.channels.get(channelName, { params: { agent: channelAgent(responsesCodec) } });
  const transport = createAgentTransport({ channel, codec: responsesCodec });
  await transport.connect();

  const located = await transport.locateInput(body.eventId);
  if (!located) {
    transport.close();
    ably.close();
    return Response.json({ error: `no input event found for eventId ${body.eventId}` }, { status: 400 });
  }

  // Every input this demo publishes carries no run-id, so every open is a
  // fresh `ai-run-start`. Opening from the located input anchors the run to
  // its trigger, which is what lets a cancel route back here and lets the
  // client resolve the run id off the channel.
  const run = transport.openRun({ input: located }, { signal: req.signal });

  // The conversation for the model: the store, plus the input that woke this
  // invocation (see lib/conversation.ts). No channel history is paged — the
  // store is the whole record.
  const conversation = openConversation(channelName, run.runId, located);
  const input = toResponsesInput(conversation.messages());
  const priorMessages = conversation.messages();

  // Store the prompt as the run opens, so a page loading mid-run sees what
  // started the reply it is watching.
  await conversation.save();

  after(async () => {
    try {
      // The agentic loop (model turn → run tools → continue) publishes each unit
      // of work under its own pipe, so a run produces several messages. It emits
      // both the model's events and the codec's function_call_output /
      // tool-approval-request events, reports each batch through `record`, and
      // returns the aggregate outcome.
      const outcome = await runAgentLoop({ run, input, priorMessages, record: conversation.record });
      // Every run ends here. A cancel takes precedence over whatever the loop
      // reported; otherwise the loop's own outcome is the terminal, including
      // when it stopped because a tool needs the client — that answer wakes a
      // new run rather than resuming this one.
      await run.end(run.abortSignal.aborted ? { reason: 'cancelled' } : outcome);
      // The turn is over: store what it produced. Everything the loop published
      // is in the conversation by now, recorded batch by batch as it went.
      await conversation.save();
    } catch (error) {
      // Fire-and-forget background work: no active caller to surface this to, so
      // log it for local-demo visibility.
      console.error('[openai-demo] agent run failed', error);
    } finally {
      transport.close();
      ably.close();
    }
  });

  // The POST only wakes the agent. The run id arrives on the channel as
  // `ai-run-start`, which is how the client's merge tracks the run, so nothing
  // here needs a body.
  return new Response('', { status: 202 });
}
