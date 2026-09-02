/**
 * Messages API route — the client's hydration source, over the demo's
 * conversation store.
 *
 * GET answers with the conversation the store holds: the decoded transport
 * events (oldest first) plus the channel serial they run up to. That read
 * touches no Ably connection and no channel history, because it is standing in
 * for the query an app would make against its own database. The client merges
 * the returned events itself, then pages its own transport's history only for
 * the gap newer than `latestSerial` — the seam between what the store covered
 * and where its live subscription attached.
 *
 * POST saves a conversation. The client calls it once a run has ended, sending
 * the completed runs it holds and the serial they run up to (see
 * `hooks/use-responses-thread.ts`). Nothing that is still streaming is ever
 * written, so the store never seeds a client with half a run.
 */

import { loadConversation, saveConversation } from '../../lib/message-store';
import type { ThreadEvent } from '../../lib/get-existing-messages';

export function GET(req: Request) {
  const channelName = new URL(req.url).searchParams.get('channelName');
  if (!channelName) {
    return Response.json({ error: 'channelName is required' }, { status: 400 });
  }
  return Response.json(loadConversation(channelName));
}

/** The save body the demo's client POSTs once a run has ended. */
interface SaveRequestBody {
  /** The conversation key (the channel name). */
  channelName: string;
  /** The conversation's decoded events, oldest first. */
  events: ThreadEvent[];
  /** The channel serial the events run up to. */
  latestSerial?: string;
}

export async function POST(req: Request) {
  // CAST: trust boundary — the POST body is the demo's own client's save
  // request, narrowed by the shape guard below.
  const body = (await req.json()) as SaveRequestBody;
  if (typeof body.channelName !== 'string' || !Array.isArray(body.events)) {
    return Response.json({ error: 'channelName and events are required' }, { status: 400 });
  }
  await saveConversation(body.channelName, body.events, body.latestSerial);
  return Response.json({ ok: true });
}
