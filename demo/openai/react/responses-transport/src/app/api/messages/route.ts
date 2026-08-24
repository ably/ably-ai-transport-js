/**
 * Messages API route — the client's hydration source.
 *
 * Answers a GET with the conversation so far: the decoded transport events
 * (oldest first) plus the channel serial of the newest one, read through the
 * same `getExistingMessages` the chat route merges model context from — minus
 * any run that has not ended, which the client owns end to end. The
 * client merges the returned events itself, then pages its own transport's
 * history only for the gap newer than `latestSerial` — the seam between what
 * this response covered and where the client's live subscription attached.
 * Swapping the channel for a database later means reimplementing
 * `getExistingMessages` only; this route and its client keep their contract.
 */

import Ably from 'ably';
import { channelAgent, createAgentTransport } from '@ably/ai-transport';

import { getExistingMessages, seedableEvents } from '../../lib/get-existing-messages';
import { responsesCodec } from '../../lib/openai-thread';

export async function GET(req: Request) {
  const channelName = new URL(req.url).searchParams.get('channelName');
  if (!channelName) {
    return Response.json({ error: 'channelName is required' }, { status: 400 });
  }

  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'ABLY_API_KEY not set' }, { status: 500 });
  }

  // A fresh Ably client per request, like the chat route: the reader attaches,
  // pages history, and closes.
  const ably = new Ably.Realtime({
    key: apiKey,
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });

  try {
    const channel = ably.channels.get(channelName, { params: { agent: channelAgent(responsesCodec) } });
    const transport = createAgentTransport({ channel, codec: responsesCodec });
    await transport.connect();
    try {
      const all = await getExistingMessages(transport);
      // A run still streaming is left for the client's own walk and live
      // subscription to own; seeding it as well would count its accumulated
      // prefix twice. See `seedableEvents`.
      const { events, latestSerial } = seedableEvents(all.events);
      return Response.json({ events, latestSerial });
    } finally {
      transport.close();
    }
  } catch (error) {
    // Without this the rejection escapes as an opaque 500 and the client
    // quietly degrades to live-only, showing an empty conversation with no
    // sign that hydration failed at all.
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `unable to read the conversation; ${message}` }, { status: 500 });
  } finally {
    ably.close();
  }
}
