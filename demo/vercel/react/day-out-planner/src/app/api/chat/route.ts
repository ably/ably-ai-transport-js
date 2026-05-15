/**
 * Chat route for the day-out-planner demo.
 *
 * Every user message sent via view.send() hits this endpoint. If the latest
 * user message mentions @bernard, we run the LLM with itinerary tools that
 * write to a sibling channel's LiveObjects root LiveMap. Otherwise we close
 * the run immediately so the message becomes plain chat between users.
 *
 * The itinerary lives on a separate channel (`<chat channel>:itinerary`)
 * because the AI Transport SDK's internal channels.get() call wipes
 * channel modes — see README → "Itinerary lives on a sibling channel".
 */

import { after } from 'next/server';
import { convertToModelMessages, streamText } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { LiveObjects, type LiveMapPathObject } from 'ably/liveobjects';
import { createAgentSession } from '@ably/ai-transport/vercel';
import type { InvocationData, MessageNode } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { buildTools } from './tools';
import { itineraryChannelName, type ItineraryRoot } from '../../itinerary';

const ably = new Ably.Realtime({
  key: process.env.ABLY_API_KEY!,
  plugins: { LiveObjects },
});

const ITINERARY_CHANNEL_MODES: Ably.ChannelMode[] = ['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH'];

const rootCache = new Map<string, Promise<LiveMapPathObject<ItineraryRoot>>>();

function getItineraryRoot(chatChannelName: string): Promise<LiveMapPathObject<ItineraryRoot>> {
  let cached = rootCache.get(chatChannelName);
  if (!cached) {
    const channel = ably.channels.get(itineraryChannelName(chatChannelName), { modes: ITINERARY_CHANNEL_MODES });
    cached = channel.object.get<ItineraryRoot>();
    rootCache.set(chatChannelName, cached);
  }
  return cached;
}

function textOf(msg: UIMessage | undefined): string {
  if (!msg) return '';
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function mentionsBernard(text: string): boolean {
  return /@bernard\b/i.test(text);
}

function describeItinerary(root: LiveMapPathObject<ItineraryRoot>): string {
  const data = root.compactJson();
  if (!data || 'objectId' in data) return 'The itinerary is currently empty.';
  const lines: string[] = [];
  for (const [id, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue;
    lines.push(`- ${id}: ${value}`);
  }
  if (lines.length === 0) return 'The itinerary is currently empty.';
  return `The itinerary currently contains these items (each stored as a JSON string keyed by id):\n${lines.join('\n')}`;
}

function annotateSender(node: MessageNode<UIMessage>): UIMessage {
  if (node.message.role !== 'user') return node.message;
  const sender = node.headers['x-ably-run-client-id'];
  if (!sender) return node.message;
  return {
    ...node.message,
    parts: node.message.parts.map((part) =>
      part.type === 'text' ? { ...part, text: `${sender}: ${part.text}` } : part,
    ),
  };
}

const SYSTEM_PROMPT = `You are Bernard, a friendly planning agent embedded in a group chat.

Several human users are chatting about what to do together on a day out. Each
user message in the chat history is prefixed with their name (e.g. "alice: ..."),
so you can attribute who said what when you reply.

When asked to help, your job is to:
- Read the recent conversation to understand what they want.
- Suggest concrete real-world places (cinemas, restaurants, museums, parks, etc.).
- Estimate latitude/longitude from your own knowledge of the area — accuracy
  to about 3 decimal places is fine. You do not have web access.
- Use the itinerary tools to write your decisions into the shared itinerary
  (which the users see as a map and a list). Add one item per place. Reuse
  an item's id to update it instead of duplicating.
- Reply in chat with a short, friendly summary of what you added, including
  rough timings.

Each itinerary item has a numeric \`order\` field. Items are rendered in
ascending order. To insert a new item between two existing ones, pick any
number between their orders (floats are fine — e.g. 1.5 between 1 and 2)
so you don't need to update the neighbours. To put an item before
everything pick a smaller number; to put it at the end pick a larger one.
The conversation history (and the latest tool results you've made) tells
you which orders are already taken.

If the request is genuinely ambiguous, ask a clarifying question instead of
guessing wildly. If you have enough to make a reasonable plan, just do it.
Keep replies short — the map and list show the detail.`;

export async function POST(req: Request) {
  // CAST: req.json() returns unknown; the client SDK posts the documented InvocationData shape.
  const data = (await req.json()) as InvocationData<UIMessageChunk, UIMessage>;
  const invocation = Invocation.fromJSON(data);

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();

  const newNodes = run.view.messages;
  const lastUserNode = [...newNodes].reverse().find((n) => n.message.role === 'user');
  const lastUserText = textOf(lastUserNode?.message);

  if (!mentionsBernard(lastUserText)) {
    after(async () => {
      await run.end('complete');
      session.close();
    });
    return new Response(null, { status: 200 });
  }

  const root = await getItineraryRoot(invocation.sessionName);

  const history = [...invocation.history, ...newNodes].map(annotateSender);
  const modelMessages = await convertToModelMessages(history);

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: `${SYSTEM_PROMPT}\n\n${describeItinerary(root)}`,
    messages: modelMessages,
    tools: buildTools(root),
    abortSignal: run.abortSignal,
  });

  after(async () => {
    await run.pipe(result.toUIMessageStream());
    await run.end('complete');
    session.close();
  });

  return new Response(null, { status: 200 });
}
