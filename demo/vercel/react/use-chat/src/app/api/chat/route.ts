/**
 * Chat API route — receives messages from the client session's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Supports three tool execution patterns:
 * - Server-executed tools (getWeather): streamText runs them inline.
 * - Client-executed tools (getLocation): the client suspends the run after
 *   the tool call, executes the tool, then sends a continuation invocation
 *   under the same runId. The SDK overlays the client-published tool output
 *   onto the suspended assistant before `run.messages` is read.
 * - Server-executed gated on approval (getWeatherForecast): suspends at
 *   `approval-requested`. The user approves → the client publishes a
 *   `tool-approval-response` TEvent on the channel → continuation POST →
 *   `run.messages` reflects the approval. The tool's `needsApproval`
 *   returns `false` once the matching `toolCallId` has an
 *   `approval-responded` part in the messages, so `streamText` executes
 *   it without re-pausing. The codec reducer folds the resulting tool
 *   output onto the original assistant message by matching its
 *   `toolCallId`.
 */

import { after } from 'next/server';
import { streamText, generateText, convertToModelMessages, stepCountIs } from 'ai';
import Ably from 'ably';
import {
  createAgentSession,
  vercelRunOutcome,
  vercelGenerateTextOutcome,
  generateTextToUIMessageStream,
} from '@ably/ai-transport/vercel';
import type { VercelRunOutcome } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { createModel } from './model';
import { tools } from './tools';

export async function POST(req: Request) {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  // A fresh Ably client per request (trusted environment, API key direct).
  // The agent is ephemeral: it attaches the channel, looks up the triggering
  // input event via `untilAttach: true` history (scoped by
  // `inputEventLookbackMs`), streams the response, and closes. A per-request
  // client keeps concurrent runs on the same channel from detaching each
  // other.
  // `ABLY_ENDPOINT` lets the e2e tests point the agent at the Ably sandbox
  // (`nonprod:sandbox`); unset in normal use, so it defaults to production.
  const ably = new Ably.Realtime({
    key: process.env.ABLY_API_KEY!,
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();
  await run.loadConversation();

  // Demo toggle (AIT-870): when DEMO_GENERATION_MODE=complete the agent uses the
  // one-shot `generateText()` instead of `streamText()`. The client (useChat)
  // is identical in both modes — only how the backend produces the response
  // differs. `generateText` returns the whole result in one go (and rejects on
  // failure), so we convert it to the UIMessageChunk stream the transport
  // expects and derive the outcome from its settled finishReason.
  const generateComplete = process.env.DEMO_GENERATION_MODE === 'complete';

  const model = createModel();
  const system = `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`;
  const messages = await convertToModelMessages(run.messages);

  after(async () => {
    let outcome: VercelRunOutcome;

    if (generateComplete) {
      try {
        const result = await generateText({
          model,
          system,
          messages,
          tools,
          abortSignal: run.abortSignal,
          stopWhen: stepCountIs(10),
        });
        const pipeResult = await run.pipe(generateTextToUIMessageStream(result));
        outcome = vercelGenerateTextOutcome(pipeResult, result.finishReason);
      } catch (error) {
        // generateText rejects on abort (cancellation) or generation failure.
        // Mirror the streamText path: forward the failure to clients so they
        // can show why the run failed.
        outcome =
          error instanceof Error && error.name === 'AbortError'
            ? { reason: 'cancelled' }
            : {
                reason: 'error',
                error: new Ably.ErrorInfo(
                  `unable to complete run; ${error instanceof Error ? error.message : String(error)}`,
                  50000,
                  500,
                ),
              };
      }
    } else {
      const result = streamText({
        model,
        system,
        messages,
        tools,
        abortSignal: run.abortSignal,
        stopWhen: stepCountIs(10),
      });
      const pipeResult = await run.pipe(result.toUIMessageStream());
      outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    }

    if (outcome.reason === 'suspend') {
      await run.suspend();
    } else {
      // We choose to forward the run's terminal error so clients can show why
      // the run failed; a server could omit it to avoid exposing internal
      // failure detail.
      await run.end(outcome);
    }
    await session.close();
    ably.close();
  });

  // Return the agent-minted ids on the HTTP response. The agent now mints both
  // the run-id (when the invocation omits it for a fresh run) and the
  // invocation-id; the useChat ChatTransport's POST ignores the body (it routes
  // by run-id over the channel), but the contract is honoured here.
  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
