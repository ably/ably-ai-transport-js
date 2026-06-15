/**
 * Bernard's agent endpoint for the day-out-planner demo.
 *
 * A client POSTs here (the invocation pointer) only when it wants Bernard to
 * act — i.e. when a message mentions @bernard. The chat history itself lives on
 * the Ably channel, so this handler reconstructs the conversation from the
 * channel, runs the LLM with the itinerary tools, and streams the reply back
 * over the same channel. The itinerary is a LiveObjects map on that same
 * channel, written by Bernard's tools.
 */

import { after } from 'next/server';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { LiveObjects, type LiveMapPathObject } from 'ably/liveobjects';
import { OBJECT_MODES, Invocation, type InvocationData } from '@ably/ai-transport';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
import { buildTools } from './tools';
import { type ItineraryRoot } from '../../itinerary';

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

function systemPrompt(asker: string | undefined, root: LiveMapPathObject<ItineraryRoot>): string {
  return `You are Bernard, a friendly planning agent in a group chat where several
people are planning a day out together.

${asker ? `The person who just asked for your help is "${asker}".` : ''} The chat
history is the group's shared conversation; address the group naturally.

Your job when asked to help:
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
Keep replies short — the map and list show the detail.

${describeItinerary(root)}`;
}

export async function POST(req: Request) {
  // CAST: req.json() returns unknown; the client posts the documented InvocationData shape.
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  const ably = new Ably.Realtime({
    key: process.env.ABLY_API_KEY!,
    plugins: { LiveObjects },
  });

  const session = createAgentSession({
    client: ably,
    channelName: invocation.sessionName,
    channelModes: OBJECT_MODES,
  });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();
  await run.loadConversation();

  const root = await session.object.get<ItineraryRoot>();
  const asker = session.tree.getRunNode(run.runId)?.clientId || undefined;

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: systemPrompt(asker, root),
    messages: await convertToModelMessages(run.messages),
    tools: buildTools(root),
    abortSignal: run.abortSignal,
    // Multi-step: let streamText loop inference + the itinerary tools within
    // this call so a tool call chains into the model's next pass and produces
    // the final chat reply, rather than suspending the run after each tool.
    stopWhen: stepCountIs(10),
  });

  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream());
    const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    if (outcome === 'suspend') {
      await run.suspend();
    } else {
      await run.end(outcome);
    }
    await session.close();
    ably.close();
  });

  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
