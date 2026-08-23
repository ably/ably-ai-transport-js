/**
 * Messages API route — the demo's conversation store, over REST.
 *
 * GET returns the persisted `UIMessage`s for a conversation — the seed a
 * client hydrates from before paging the channel-history gap. POST appends a
 * completed turn: the client calls it from useChat's `onFinish`, and the
 * store upserts by domain `message.id`, so re-persisting a turn is idempotent.
 */

import type { UIMessage } from 'ai';
import { appendMessages, loadMessages } from '../../lib/message-store';

export function GET(req: Request): Response {
  const conversationId = new URL(req.url).searchParams.get('conversationId');
  if (!conversationId) {
    return Response.json({ error: 'conversationId is required' }, { status: 400 });
  }
  return Response.json(loadMessages(conversationId));
}

/** The persist body the client POSTs on each completed turn. */
interface PersistRequestBody {
  /** The conversation key (the channel name). */
  conversationId: string;
  /** The completed turn's messages, oldest-first. */
  messages: UIMessage[];
}

export async function POST(req: Request): Promise<Response> {
  // CAST: trust boundary — the POST body is our own client's persist request,
  // narrowed by the shape guards below.
  const body = (await req.json()) as PersistRequestBody;
  if (typeof body.conversationId !== 'string' || !Array.isArray(body.messages)) {
    return Response.json({ error: 'conversationId and messages are required' }, { status: 400 });
  }
  await appendMessages(body.conversationId, body.messages);
  return Response.json({ ok: true });
}
