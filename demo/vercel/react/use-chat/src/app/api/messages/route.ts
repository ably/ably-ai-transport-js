/**
 * Messages API route — the client's hydration source.
 *
 * GET answers with the conversation the server's store holds for a channel,
 * plus the run streaming on it right now if there is one. It touches no Ably
 * connection and reads no channel history, because it stands in for the query
 * an app makes against its own database.
 *
 * There is no write side. The chat route owns every write (see
 * `lib/message-store.ts`), so a client cannot put anything in the store that
 * the agent did not produce.
 */

import { loadConversation } from '../../lib/message-store';

export function GET(req: Request) {
  const channelName = new URL(req.url).searchParams.get('channelName');
  if (!channelName) {
    return Response.json({ error: 'channelName is required' }, { status: 400 });
  }
  return Response.json(loadConversation(channelName));
}
