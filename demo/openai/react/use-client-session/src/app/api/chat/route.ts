/**
 * Chat API route — receives an invocation from the client session's HTTP POST,
 * runs the OpenAI Responses model, and streams the reply back over Ably.
 *
 * Uses the generic, codec-agnostic transport (`createAgentSession` from
 * `@ably/ai-transport`) parameterized by the OpenAI `ResponsesCodec`; there is
 * no OpenAI-specific transport layer. Continuation handling lives in the SDK:
 * `run.loadConversation()` returns the LLM-ready conversation as `OpenAITurn[]`,
 * which `toResponsesInput` flattens into the `/responses` `input` array.
 *
 * The model stream is filtered to the codec's supported event types before
 * `run.pipe` — the codec deliberately throws on unrecognised output events, and
 * a real Responses stream can carry events outside the text-only subset (see
 * `supported-events.ts`).
 *
 * Text-only run outcome: `pipe` reports the terminal reason directly. A model
 * failure delivered in-band (a `response.failed` / `error` event) is not mapped
 * to a run-end error here — TODO(AIT-742): a run-outcome mapper lands with the
 * function-call / tool increments.
 */

import { after } from 'next/server';
import Ably from 'ably';
import { createAgentSession } from '@ably/ai-transport';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { ResponsesCodec, toResponsesInput } from '@ably/ai-transport/openai';

import { createResponseStream } from './model';
import { filterSupportedEvents } from './supported-events';

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

  await run.start();
  // loadConversation() returns the full multi-turn conversation to feed the
  // model; toResponsesInput flattens it into the /responses input array.
  const conversation = await run.loadConversation();
  const input = toResponsesInput(conversation);

  after(async () => {
    try {
      const modelStream = await createResponseStream({ input, signal: run.abortSignal });
      // Filter to the codec's supported event types before piping — the codec
      // throws on anything it can't encode.
      const stream = modelStream.pipeThrough(filterSupportedEvents());
      const result = await run.pipe(stream);
      // The ternary only discriminates RunEndParams (its 'error' arm is a
      // separate shape). We don't attach the original failure: pipe's error is
      // a plain Error, not an Ably.ErrorInfo, and the text-only run outcome is
      // just complete/cancelled/error. TODO(AIT-742): a run-outcome mapper that
      // converts and forwards the error lands with the tool increments.
      await run.end(result.reason === 'error' ? { reason: 'error' } : { reason: result.reason });
    } catch (error) {
      // Fire-and-forget background work: no active caller to surface this to, so
      // log it for local-demo visibility.
      console.error('[openai-demo] agent run failed', error);
    } finally {
      await session.close();
      ably.close();
    }
  });

  // Return the agent-minted ids on the HTTP response. The same ids also arrive
  // on the channel as `ai-run-start`, which is how the client resolves
  // `run.started` without reading this response.
  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
