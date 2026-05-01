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
 *   `run.loadProjection()` reflects the approval. The tool's
 *   `needsApproval` function returns `false` once the matching
 *   `toolCallId` has an `approval-responded` part in the messages, so
 *   `streamText` executes it without re-pausing. `run.pipe`'s internal
 *   `resolveToolTarget` redirects the resulting tool-output wire message
 *   back to the original assistant message via `HEADER_MSG_ID`.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { DynamicToolUIPart, UIMessage } from 'ai';
import Ably from 'ably';
import { createAgentSession, UIMessageCodec, vercelRunEndReason } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { createModel } from './model';
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

  let resolvedMessages: UIMessage[];

  // Continuation under an existing run, with history that still carries
  // assistant messages whose tool parts haven't been resolved (client tool
  // output / approval response). Fold the run's channel events through the
  // codec and overlay the projection's reduced messages on the history —
  // client tool outputs and approval responses are merged onto their
  // original dynamic-tool parts by the reducer.
  // TODO: drop this branch when session state loads from the channel rather than the invocation body.
  if (invocation.isContinuation && invocation.history.some(({ message }) => hasUnresolvedToolPart(message))) {
    // TODO: when all session state is loaded from the channel, the run.loadProjection() call won't be needed.
    // Right now we are in a middle ground where the _run state_ is loaded from the channel; so the existing run
    // parts on continuation, and the tool-call approvals for that run are on the channel. But the rest of the
    // converstaion history is still loaded from the invocation body.
    const projection = await run.loadProjection();
    const projectedById = new Map(UIMessageCodec.getMessages(projection).map((m) => [m.id, m]));
    resolvedMessages = invocation.history.map((node) => projectedById.get(node.message.id) ?? node.message);
  } else {
    resolvedMessages = invocation.history.map((h) => h.message);
  }

  // TODO: when we load session state from the channel. we will only use run.view.messages.
  // In the mean time, run.view.messages contains _this run's state_, and resolvedMessages are coming from the invocation
  const newNodes = run.view.messages;
  const allMessages = [...resolvedMessages, ...newNodes.map((m) => m.message)];

  const result = streamText({
    model: createModel(),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(allMessages),
    tools,
    abortSignal: run.abortSignal,
  });

  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream());
    const endReason = await vercelRunEndReason(pipeResult, result.finishReason);
    await run.end(endReason);
    session.close();
  });

  return new Response(null, { status: 200 });
}
