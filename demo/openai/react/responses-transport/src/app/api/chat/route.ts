/**
 * Chat API route — woken by the client's HTTP POST, runs the OpenAI Responses
 * model, and streams the reply back over Ably.
 *
 * Uses the generic, codec-agnostic agent transport (`createAgentTransport`
 * from `@ably/ai-transport`) parameterized by the demo's typed Responses codec instance;
 * there is no OpenAI-specific transport layer. The wake body carries the
 * channel name and the triggering input's `eventId` (matched on the channel
 * via `locateInput`); a continuation input carries the run-id header of the
 * run it resumes, so the trigger alone decides whether the open is a fresh
 * `ai-run-start` or an `ai-run-resume`. The conversation for the model comes from
 * `getExistingMessages`, which pages the transport's history to exhaustion and
 * merges it through the same merge helper the frontend renders with, then
 * flattens into the `/responses` `input` array by `toResponsesInput`.
 *
 * That same page is what populates the demo's conversation store
 * (`lib/message-store.ts`), which clients hydrate from over
 * `GET /api/messages`. The server owns every write, so a client cannot put
 * anything in the store the agent did not produce, and the read path touches
 * no Ably connection. The write covers this invocation's trigger and every
 * earlier run; the run about to start is what a hydrating client walks the
 * channel for.
 *
 * Tools run inside the agentic loop (`runAgentLoop`). A server-executed tool
 * does not suspend the run — the loop runs it, publishes its
 * `function_call_output`, and continues `/responses` until the model produces a
 * final reply. A client-executed or approval-gated tool suspends the run: the
 * loop returns a `suspend` outcome and the route calls `run.suspend()`; a later
 * continuation (the client's `function_call_output` item or approval) resumes
 * the run under the same runId, re-entering this route. The loop publishes each unit of work under
 * its own `run.pipe`, so a run that calls a tool produces several messages (the
 * model turn, the tool outputs, the final turn). Each pipe's stream goes to the
 * run as-is: the codec's descriptor table curates the wire, dropping the framing
 * events no consumer reads and throwing on any genuinely unexpected event.
 *
 * Run outcome: `runAgentLoop` returns an {@link AgentLoopOutcome}. A cancel
 * (client cancel or request abort) ends the run `cancelled`; the `suspend` arm
 * maps onto `run.suspend()`; every other arm is a `RunEndParams` (the error
 * arm already carrying the wrapped `Ably.ErrorInfo`), forwarded to `run.end()`
 * directly.
 */

import { after } from 'next/server';
import Ably from 'ably';
import { channelAgent, createAgentTransport } from '@ably/ai-transport';

import { responsesCodec, toResponsesInput } from '../../lib/openai-thread';

import { getExistingMessages, storableConversation } from '../../lib/get-existing-messages';
import { saveConversation } from '../../lib/message-store';
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

  const channel = ably.channels.get(body.channelName, { params: { agent: channelAgent(responsesCodec) } });
  const transport = createAgentTransport({ channel, codec: responsesCodec });
  await transport.connect();

  const located = await transport.locateInput(body.eventId);
  if (!located) {
    transport.close();
    ably.close();
    return Response.json({ error: `no input event found for eventId ${body.eventId}` }, { status: 400 });
  }

  // The conversation for the model: the existing thread read off the channel
  // (see get-existing-messages.ts), flattened into the /responses input array.
  // The triggering input is already on the channel (the client publishes
  // before it POSTs), so the merge covers it too.
  const existing = await getExistingMessages(transport);
  const input = toResponsesInput(existing.messages);

  // Write the store from the page just read, as merged messages rather than
  // events — the merge happens once, here, with OpenAI's own accumulator. The
  // server owns every write, so the client never puts anything here that the
  // agent did not produce. This one page is the whole cost: it stores this
  // invocation's own trigger and every earlier run, leaving only the run about
  // to start for a hydrating client to walk. A run still streaming is left out
  // entirely, because its accumulated prefix must be decoded once and only
  // once (see `storableConversation`).
  await saveConversation(body.channelName, storableConversation(existing));

  // The trigger drives the open: a continuation input carries the run-id
  // header of the run it resumes, and a fresh send carries none — the
  // transport re-enters or starts accordingly and anchors the run to the
  // trigger so cancels route.
  const run = transport.openRun({ input: located }, { signal: req.signal });

  after(async () => {
    try {
      // The agentic loop (model turn → run tools → continue) publishes each unit
      // of work under its own pipe, so a run produces several messages. It emits
      // both the model's events and the codec's function_call_output /
      // tool-approval-request events, and returns the aggregate outcome.
      const outcome = await runAgentLoop({ run, input, priorMessages: existing.messages });
      if (run.abortSignal.aborted) {
        // A client cancel (or request abort) stopped the stream; the agent owns
        // publishing the terminal.
        await run.end({ reason: 'cancelled' });
      } else if (outcome.reason === 'suspend') {
        // A client-executed or approval-gated tool paused the run. Suspend it
        // (publishing the suspend signal); the client resolves the tool and
        // sends a continuation that resumes this run under the same runId.
        await run.suspend();
      } else {
        await run.end(outcome);
      }
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
