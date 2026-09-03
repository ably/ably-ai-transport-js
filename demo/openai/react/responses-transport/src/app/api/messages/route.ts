/**
 * Messages API route — the client's hydration source, over the demo's
 * conversation store.
 *
 * GET answers with the conversation the store holds: already-merged messages
 * and runs, plus the channel serial they are complete up to. That read touches
 * no Ably connection and no channel history, because it is standing in for the
 * query an app would make against its own database. The client seeds its merge
 * with those messages, then pages its own transport's history only for the gap
 * newer than `latestSerial` — the seam between what the store covered and
 * where its live subscription attached.
 *
 * There is no write side. The chat route owns every write, building the thread
 * from what the run itself published plus the input that woke it (see
 * `api/chat/route.ts`), so a client cannot put anything in the store the agent
 * did not produce.
 */

import { loadConversation } from '../../lib/message-store';

export function GET(req: Request) {
  const channelName = new URL(req.url).searchParams.get('channelName');
  if (!channelName) {
    return Response.json({ error: 'channelName is required' }, { status: 400 });
  }
  return Response.json(loadConversation(channelName));
}
