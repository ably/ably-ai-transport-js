/**
 * Chat API route — receives an invocation from the client session's HTTP POST,
 * runs the OpenAI Responses model, and streams the reply back over Ably.
 *
 * Uses the generic, codec-agnostic transport (`createAgentSession` from
 * `@ably/ai-transport`) parameterized by the OpenAI `ResponsesSessionCodec`; there is
 * no OpenAI-specific transport layer. Continuation handling lives in the SDK:
 * draining `run.view` yields the LLM-ready conversation as `OpenAIMessage[]`,
 * which `toResponsesInput` flattens into the `/responses` `input` array.
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
 * Run outcome: `runAgentLoop` returns an {@link AgentLoopOutcome}. Its `suspend`
 * arm maps onto `run.suspend()`; every other arm is a `RunEndParams` (the error
 * arm already carrying the wrapped `Ably.ErrorInfo`), forwarded to `run.end()`
 * directly.
 */

import { after } from 'next/server';
import Ably from 'ably';
import { createAgentSession } from '@ably/ai-transport';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { ResponsesSessionCodec, toResponsesInput } from '@ably/ai-transport/openai';

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

  const session = createAgentSession({
    client: ably,
    channelName: invocation.sessionName,
    codec: ResponsesSessionCodec,
  });
  await session.connect();
  // No identity is pinned: this run is not retried, so a generated run-id and
  // invocation-id are correct.
  const run = session.createRun(invocation, {}, { signal: req.signal });

  // Drain run.view — the one history driver — for the full multi-turn
  // conversation to feed the model, then start. toResponsesInput flattens it
  // into the /responses input array.
  while (run.view.hasOlder()) await run.view.loadOlder();
  await run.start();
  const priorMessages = run.view.getMessages().map((m) => m.message);
  const input = toResponsesInput(priorMessages);

  after(async () => {
    try {
      // The agentic loop (model turn → run tools → continue) publishes each unit
      // of work under its own pipe, so a run produces several messages. It emits
      // both the model's events and the codec's function_call_output events, and
      // returns the aggregate outcome. Run termination stays out-of-band.
      const outcome = await runAgentLoop({ run, input, priorMessages });
      if (outcome.reason === 'suspend') {
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
      await session.end();
      ably.close();
    }
  });

  // Return the agent-minted ids on the HTTP response. The same ids also arrive
  // on the channel as `ai-run-start`, which is how the client resolves
  // `run.started` without reading this response.
  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
