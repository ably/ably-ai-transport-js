/**
 * Messages API route — reads the persisted conversation a client seeds from.
 *
 * Returns the domain `UIMessage`s the agent has written to the in-memory store
 * for a conversation (the agent persists each terminal run's whole turn in the
 * chat route). The client fetches this on load to seed `useChat({ messages })`,
 * then `useMessageSync` reconciles it with the live channel at the seam.
 */

import { loadMessages } from '../../lib/message-store';

export function GET(req: Request): Response {
  const conversationId = new URL(req.url).searchParams.get('conversationId');
  if (!conversationId) {
    return Response.json({ error: 'conversationId is required' }, { status: 400 });
  }
  return Response.json(loadMessages(conversationId));
}
