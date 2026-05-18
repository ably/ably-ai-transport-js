/**
 * Chat API route — receives messages from the client session's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Supports three tool execution patterns:
 * - Server-executed tools (getWeather): streamText runs them inline.
 * - Client-executed tools (getLocation): the client suspends the run after
 *   the tool call, executes the tool, then sends a continuation invocation
 *   under the same runId. The continuation calls `run.loadProjection()` —
 *   which folds every channel message bound to the runId through the codec
 *   — and uses the projection's UIMessages (now with the tool output merged
 *   onto the right dynamic-tool part) as the resumed history.
 * - Server-executed gated on approval (getWeatherForecast): suspends at
 *   `approval-requested`. The user approves → the client publishes an
 *   `ait-tool-approval` TEvent on the channel → continuation POST →
 *   `run.loadProjection()` reflects the approval; `disableApprovalsForApproved`
 *   stops the multi-step loop pausing on the same tool again; `run.pipe`'s
 *   internal `resolveToolTarget` redirects the resulting tool-output wire
 *   message back to the original assistant message via `HEADER_MSG_ID`.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { DynamicToolUIPart, UIMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { createAgentSession, disableApprovalsForApproved, UIMessageCodec } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { tools } from './tools';

// Server-side Ably client — uses API key directly (trusted environment).
const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

const UNRESOLVED_TOOL_STATES = new Set(['input-streaming', 'input-available', 'approval-requested']);

const hasUnresolvedToolPart = (message: UIMessage): boolean =>
  message.role === 'assistant' &&
  message.parts.some(
    (part) => part.type === 'dynamic-tool' && UNRESOLVED_TOOL_STATES.has((part as DynamicToolUIPart).state),
  );

export async function POST(req: Request) {
  const data = (await req.json()) as InvocationData<UIMessage>;
  const invocation = Invocation.fromJSON(data);

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();

  // Continuation: no new user prompt, but the history carries assistant
  // messages with unresolved tool parts. Fold the run's channel events
  // through the codec and use the projection's reduced messages as the
  // resumed history — client tool outputs and approval responses are
  // already merged onto their original dynamic-tool parts by the reducer.
  let resolvedMessages: UIMessage[];
  if (invocation.isContinuation && invocation.history.some(({ message }) => hasUnresolvedToolPart(message))) {
    const projection = await run.loadProjection();
    const projectedById = new Map(UIMessageCodec.getMessages(projection).map((m) => [m.id, m]));
    resolvedMessages = invocation.history.map((node) => projectedById.get(node.message.id) ?? node.message);
  } else {
    resolvedMessages = invocation.history.map((h) => h.message);
  }

  const newNodes = run.view.messages;
  const allMessages = [...resolvedMessages, ...newNodes.map((m) => m.message)];

  // Prevent the multi-step loop from re-pausing on a tool the user just
  // approved. Reads the approval state off the resolved history (which
  // already reflects the projection).
  const effectiveTools = disableApprovalsForApproved(allMessages, tools);

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(allMessages),
    tools: effectiveTools,
    abortSignal: run.abortSignal,
  });

  after(async () => {
    const { reason } = await run.pipe(result.toUIMessageStream());
    // When streamText finished because the LLM asked for tool calls (and
    // streamText didn't execute them server-side), suspend the run instead
    // of ending it. The client publishes the resolution on the channel
    // and sends a continuation invocation under the same runId.
    const finishReason = reason === 'complete' ? await result.finishReason : undefined;
    const endReason = finishReason === 'tool-calls' ? 'suspended' : reason;
    await run.end(endReason);
    session.close();
  });

  return new Response(null, { status: 200 });
}
