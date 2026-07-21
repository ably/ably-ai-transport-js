/**
 * Chat API route — receives an invocation from the client session's HTTP POST,
 * runs the OpenAI Responses model, and streams the reply back over Ably.
 *
 * Uses the generic, codec-agnostic transport (`createAgentSession` from
 * `@ably/ai-transport`) parameterized by the OpenAI `ResponsesCodec`; there is
 * no OpenAI-specific transport layer. Continuation handling lives in the SDK:
 * draining `run.view` yields the LLM-ready conversation as `OpenAIMessage[]`,
 * which `toResponsesInput` flattens into the `/responses` `input` array.
 *
 * Server-executed tools run inside the agentic loop (`runAgentLoop`): the run
 * does not suspend — the loop runs each tool, publishes its
 * `function_call_output`, and continues `/responses` until the model produces a
 * final reply. The loop publishes each unit of work under its own `run.pipe`,
 * so a run that calls a tool produces several messages (the model turn, the
 * tool outputs, the final turn). Each pipe's stream goes to the run as-is: the
 * codec's descriptor table curates the wire, dropping the framing events no
 * consumer reads and throwing on any genuinely unexpected event.
 *
 * Run outcome: `pipe` reports the terminal reason directly. A model failure
 * delivered in-band (a `response.failed` or stream-level `error` event) is not
 * mapped to a run-end error here — TODO(AIT-1113): a run-outcome mapper lands
 * with the client-side tool / approval increments.
 */

import { after } from 'next/server';
import Ably from 'ably';
import { createAgentSession } from '@ably/ai-transport';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { ResponsesCodec, toResponsesInput } from '@ably/ai-transport/openai';

import { runAgentLoop } from './agent-stream';

export async function POST(req: Request) {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

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

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName, codec: ResponsesCodec });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  // Drain run.view — the one history driver — for the full multi-turn
  // conversation to feed the model, then start. toResponsesInput flattens it
  // into the /responses input array.
  while (run.view.hasOlder()) await run.view.loadOlder();
  await run.start();
  const input = toResponsesInput(run.view.getMessages().map((m) => m.message));

  after(async () => {
    try {
      // The agentic loop (model turn → run tools → continue) publishes each unit
      // of work under its own pipe, so a run produces several messages. It emits
      // both the model's events and the codec's function_call_output events, and
      // returns the aggregate outcome. Run termination stays out-of-band.
      const result = await runAgentLoop({ run, input });
      // The ternary only discriminates RunEndParams (its 'error' arm is a
      // separate shape). We don't attach the original failure: the loop's error
      // is a plain Error, not an Ably.ErrorInfo, and the text-only run outcome is
      // just complete/cancelled/error. TODO(AIT-1113): a run-outcome mapper that
      // converts and forwards the error lands with the tool increments. Logged
      // here in the meantime so a local run's real failure (e.g. an OpenAI API
      // rejection) is visible somewhere, not just the client's generic
      // "agent reported an error" fallback.
      if (result.error) console.error('[openai-demo] agentic loop reported an error', result.error);
      await run.end(result.reason === 'error' ? { reason: 'error' } : { reason: result.reason });
    } catch (error) {
      // Fire-and-forget background work: no active caller to surface this to, so
      // log it for local-demo visibility.
      console.error('[openai-demo] agent run failed', error);
    } finally {
      await session.end();
      ably.close();
    }
  });

  // Return the agent-minted ids on the HTTP response. The same ids also arrive
  // on the channel as `ai-run-start`, which is how the client resolves
  // `run.started` without reading this response.
  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
