/**
 * Messages API route — the client's hydration source.
 *
 * Answers a GET with the conversation so far: the decoded transport events
 * (oldest first) plus the channel serial of the newest one, read through the
 * same `getExistingMessages` the chat route merges model context from. The
 * client merges the returned events itself, then pages its own transport's
 * history only for the gap newer than `latestSerial` — the seam between what
 * this response covered and where the client's live subscription attached.
 * Swapping the channel for a database later means reimplementing
 * `getExistingMessages` only; this route and its client keep their contract.
 */

import Ably from 'ably';
import { channelAgent, createAgentTransport } from '@ably/ai-transport';

import { getExistingMessages } from '../../lib/get-existing-messages';
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
      const { events, latestSerial } = await getExistingMessages(transport);
      return Response.json({ events, latestSerial });
    } finally {
      transport.close();
    }
  } finally {
    ably.close();
  }
}
