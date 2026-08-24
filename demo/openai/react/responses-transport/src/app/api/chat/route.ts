/**
 * Chat API route — woken by the client's HTTP POST, runs the OpenAI Responses
 * model, and streams the reply back over Ably.
 *
 * Uses the generic, codec-agnostic agent transport (`createAgentTransport`
 * from `@ably/ai-transport`) parameterized by the OpenAI `ResponsesCodec`;
 * there is no OpenAI-specific transport layer. The wake body carries the
 * channel name and the triggering input's `eventId` (matched on the channel
 * via `locateInput`); a continuation input carries the run-id header of the
 * run it resumes, so the trigger alone decides whether the open is a fresh
 * `ai-run-start` or an `ai-run-resume`. The conversation for the model comes from
 * `getExistingMessages` — the demo's one swappable history source, which pages
 * the transport's history to exhaustion and folds it through the same fold
 * helper the frontend renders with — then flattens into the `/responses`
 * `input` array by `toResponsesInput`.
 *
 * Tools run inside the agentic loop (`runAgentLoop`). A server-executed tool
 * does not suspend the run — the loop runs it, publishes its
 * `function_call_output`, and continues `/responses` until the model produces a
 * final reply. A client-executed or approval-gated tool suspends the run: the
 * loop returns a `suspend` outcome and the route calls `run.suspend()`; a later
 * continuation (the client's tool-result or approval) resumes the run under the
 * same runId, re-entering this route. The loop publishes each unit of work under
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
import { ResponsesCodec } from '@ably/ai-transport/openai';

import { toResponsesInput } from '../../lib/openai-thread';

import { getExistingMessages } from '../../lib/get-existing-messages';
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

  const channel = ably.channels.get(body.channelName, { params: { agent: channelAgent(ResponsesCodec) } });
  const transport = createAgentTransport({ channel, codec: ResponsesCodec });
  await transport.connect();

  const located = await transport.locateInput(body.eventId);
  if (!located) {
    transport.close();
    ably.close();
    return Response.json({ error: `no input event found for eventId ${body.eventId}` }, { status: 400 });
  }

  // The conversation for the model: the existing thread via the demo's one
  // swappable history source (see get-existing-messages.ts), flattened into
  // the /responses input array. The triggering input is already on the channel
  // (the client publishes before it POSTs), so the fold covers it too.
  const { messages: priorMessages } = await getExistingMessages(transport);
  const input = toResponsesInput(priorMessages);

  // The located input drives the open: a continuation input carries the
  // run-id header of the run it resumes, and a fresh send carries none — the
  // transport re-enters or starts accordingly and anchors the run to the
  // trigger so cancels route.
  const run = transport.openRun({ input: located }, { signal: req.signal });

  after(async () => {
    try {
      // The agentic loop (model turn → run tools → continue) publishes each unit
      // of work under its own pipe, so a run produces several messages. It emits
      // both the model's events and the codec's function_call_output /
      // tool-approval-request events, and returns the aggregate outcome.
      const outcome = await runAgentLoop({ run, input, priorMessages });
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

  // Return the run-id on the HTTP response. The same id also arrives on the
  // channel as `ai-run-start` / `ai-run-resume`, which is how the client's
  // fold tracks the run without reading this response.
  return Response.json({ runId: run.runId });
}
