/**
 * Chat API route — receives messages from the client session's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Supports three tool execution patterns:
 * - Server-executed tools (getWeather): streamText handles execution automatically
 * - Client-executed tools (getLocation): client sends result via view.update()
 * - Approval-required tools (getWeatherForecast): client sends a ToolApprovalDecision
 *   via view.send() with toolApprovals in the body; prepareApprovalRun patches
 *   history and tools; streamResponseWithApprovalRedirect routes the resulting
 *   tool output back to the original assistant message.
 */

import { after } from 'next/server';
import { streamText } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import {
  createAgentSession,
  prepareApprovalRun,
  streamResponseWithApprovalRedirect,
  type ToolApprovalDecision,
} from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { createTools } from './tools';

interface ChatRequestBody extends InvocationData<UIMessageChunk, UIMessage> {
  toolApprovals?: ToolApprovalDecision[];
}

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const data = (await req.json()) as ChatRequestBody;
  const { toolApprovals } = data;
  const invocation = Invocation.fromJSON(data);

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();

  if (invocation.events.length > 0) {
    await run.addEvents(invocation.events);
  }

  let lastUserMsgId: string | undefined;
  if (invocation.messages.length > 0) {
    const { msgIds } = await run.addMessages(invocation.messages, { clientId: invocation.clientId });
    lastUserMsgId = msgIds.at(-1);
  }

  const allMessages = [...invocation.history.map((h) => h.message), ...invocation.messages.map((m) => m.message)];

  const { modelMessages, tools: effectiveTools } = await prepareApprovalRun({
    messages: allMessages,
    decisions: toolApprovals,
    tools: createTools({ run }),
  });

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast. When the user asks to generate a favicon, icon, logo, or small thumbnail image, use the generateImage tool; it publishes the resulting image as its own assistant message, so keep any text response brief. When the user asks you to say something out loud or read a short message aloud, use the generateSpeech tool; it publishes the audio as its own assistant message, so keep any text response brief.`,
    messages: modelMessages,
    tools: effectiveTools,
    abortSignal: run.abortSignal,
  });

  after(async () => {
    const { reason } = await streamResponseWithApprovalRedirect(run, result.toUIMessageStream(), {
      parent: lastUserMsgId,
      decisions: toolApprovals,
    });
    await run.end(reason);
    session.close();
  });

  return new Response(null, { status: 200 });
}
