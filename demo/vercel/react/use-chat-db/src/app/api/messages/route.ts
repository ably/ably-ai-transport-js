/**
 * Messages API route — the demo's conversation store, over REST.
 *
 * GET returns the persisted `UIMessage`s for a conversation together with the
 * channel serial they are complete up to — the seed a client hydrates from
 * before walking the channel forward with `ChatTransport.readSince`. POST
 * appends a completed turn: the client calls it from useChat's `onFinish`, and
 * the store upserts by domain `message.id`, so re-persisting a turn is
 * idempotent.
 */

import type { UIMessage } from 'ai';
import { appendMessages, loadConversation } from '../../lib/message-store';

export function GET(req: Request): Response {
  const conversationId = new URL(req.url).searchParams.get('conversationId');
  if (!conversationId) {
    return Response.json({ error: 'conversationId is required' }, { status: 400 });
  }
  return Response.json(loadConversation(conversationId));
}

/** The persist body the client POSTs on each completed turn. */
interface PersistRequestBody {
  /** The conversation key (the channel name). */
  conversationId: string;
  /** The completed turn's messages, oldest-first. */
  messages: UIMessage[];
  /** The channel serial the turn is complete up to. */
  latestSerial?: string;
}

export async function POST(req: Request): Promise<Response> {
  // CAST: trust boundary — the POST body is our own client's persist request,
  // narrowed by the shape guards below.
  const body = (await req.json()) as PersistRequestBody;
  if (typeof body.conversationId !== 'string' || !Array.isArray(body.messages)) {
    return Response.json({ error: 'conversationId and messages are required' }, { status: 400 });
  }
  await appendMessages(body.conversationId, body.messages, body.latestSerial);
  return Response.json({ ok: true });
}
