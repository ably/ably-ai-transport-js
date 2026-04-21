/**
 * Server-side input validation — client side (durable execution).
 *
 * The client POSTs the user's input to the backend rather than
 * publishing directly. The backend validates, publishes run-start plus
 * user message via the session writer, and kicks off the workflow.
 */

import type * as AI from 'ai';

import type { ClientSession } from '../../../index.js';

/**
 * Handler for the send button. Delegates the publish to the server for
 * validation.
 * @param session - The client session whose name identifies the conversation.
 * @param text - The user's message text.
 * @returns Whether the request was accepted; populates `reason` when rejected.
 */
export const onSendClick = async (
  session: ClientSession<AI.UIMessageChunk, AI.UIMessage>,
  text: string,
): Promise<{ ok: boolean; reason?: string }> => {
  const res = await fetch('/api/validate-and-send', {
    method: 'POST',
    body: JSON.stringify({ sessionName: session.name, text }),
  });
  if (!res.ok) return { ok: false, reason: 'input rejected' };
  return { ok: true };
};
