/**
 * Server-side input validation — client side.
 *
 * The client POSTs the user's input to the backend instead of publishing
 * directly. The backend validates, then uses `session.writer` (without
 * `connect()`) to publish `x-ably-run-start` and the user message on the
 * client's behalf, returning an {@link InvocationData} the client uses to
 * kick off the agent.
 */

import type * as AI from 'ai';

import type { ClientSession, InvocationData } from '../../../index.js';

/**
 * Deliver an invocation to the agent HTTP endpoint.
 * @param data - The {@link InvocationData} the server route returned.
 * @returns Resolves once the POST has been dispatched.
 */
const invokeAgent = async (data: InvocationData): Promise<void> => {
  await fetch('/api/agent', { method: 'POST', body: JSON.stringify(data) });
};

/**
 * Handler for the send button. Delegates the publish to the server for
 * validation, then forwards the returned invocation to the agent.
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
    body: JSON.stringify({ sessionName: session.sessionName, text }),
    // The request is authenticated however the app authenticates users
    // (cookies, bearer tokens, etc.); the backend uses that identity to
    // set x-ably-client-id on the publish.
  });
  if (!res.ok) return { ok: false, reason: 'input rejected' };
  const invocationData = (await res.json()) as InvocationData;
  await invokeAgent(invocationData);
  return { ok: true };
};
