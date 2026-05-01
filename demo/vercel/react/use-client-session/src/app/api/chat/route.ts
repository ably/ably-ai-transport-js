/**
 * Chat API route — receives messages from the client session's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Mirrors the use-chat demo's continuation flow:
 * - Server-executed tools (getWeather): streamText handles execution inline.
 * - Client-executed tools (getLocation): client suspends after the tool call,
 *   publishes an `ait-client-tool-output` TEvent, then sends a continuation
 *   POST. `run.loadProjection()` rebuilds the run state with the tool output
 *   already folded onto the assistant message.
 * - Approval-required tools (getWeatherForecast): client publishes an
 *   `ait-tool-approval` TEvent on Approve. The projection reflects the
 *   `approval-responded` state. The tool's `needsApproval` function returns
 *   `false` once the matching `toolCallId` has an `approval-responded`
 *   part in the messages, so `streamText` executes it without re-pausing.
 *   `Run.pipe`'s `resolveToolTarget` hook redirects the resulting tool
 *   output back to the original assistant.
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

  // Continuation: fold the run's channel events into a projection that
  // already reflects any client-published tool outputs / approval
  // responses, then use its UIMessages as the resumed history.
  let resolvedMessages: UIMessage[];
  if (invocation.isContinuation && invocation.history.some(({ message }) => hasUnresolvedToolPart(message))) {
    const projection = await run.loadProjection();
    const projectedById = new Map(UIMessageCodec.getMessages(projection).map((m) => [m.id, m]));
    resolvedMessages = invocation.history.map((node) => projectedById.get(node.message.id) ?? node.message);
  } else {
    resolvedMessages = invocation.history.map((h) => h.message);
  }

  const newNodes = run.view.messages;
  const lastUserMsgId = newNodes.at(-1)?.msgId;
  const allMessages = [...resolvedMessages, ...newNodes.map((m) => m.message)];

  const result = streamText({
    model: createModel(),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.`,
    messages: await convertToModelMessages(allMessages),
    tools,
    abortSignal: run.abortSignal,
  });

  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream(), { parent: lastUserMsgId });
    const endReason = await vercelRunEndReason(pipeResult, result.finishReason);
    await run.end(endReason);
    session.close();
  });

  return new Response(null, { status: 200 });
}
