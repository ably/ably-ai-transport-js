/**
 * Basic chat — client side (durable execution).
 *
 * The client is indistinguishable from the serverless version: the fact
 * that the agent runs inside a WDK workflow lives entirely behind the
 * agent endpoint. The client opens a run, sends the user's message, and
 * POSTs the invocation to the workflow trigger endpoint.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

import type { ClientSession, ClientView, Codec, InvocationData } from '../../../index.js';
import { createClientSession } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;

/**
 * Deliver an invocation to the workflow HTTP trigger.
 * @param data - The {@link InvocationData} produced by `run.toInvocation().toJSON()`.
 * @returns Resolves once the POST has been dispatched.
 */
const invokeWorkflow = async (data: InvocationData): Promise<void> => {
  await fetch('/api/workflow/start', { method: 'POST', body: JSON.stringify(data) });
};

/**
 * Wire up the client session and its default view.
 * @returns The connected session and its view, ready for UI use.
 */
export const bootstrap = async (): Promise<{
  session: ClientSession<AI.UIMessageChunk, AI.UIMessage>;
  view: ClientView<AI.UIMessageChunk, AI.UIMessage>;
}> => {
  const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: 'session:abc123',
    codec,
  });
  await session.connect();

  const view = session.createView();
  view.subscribe(() => {
    // UI reads view.messages and renders them.
  });

  return { session, view };
};

/**
 * Handler for the send button. Opens a run, publishes the user's message,
 * then invokes the workflow endpoint with the invocation as precondition.
 * @param view - The client view new runs should be positioned on.
 * @param text - The text the user typed into the composer.
 * @returns Resolves once the invocation has been dispatched.
 */
export const onSendClick = async (
  view: ClientView<AI.UIMessageChunk, AI.UIMessage>,
  text: string,
): Promise<void> => {
  const run = view.createRun();
  await run.start();
  await run.send({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
  await invokeWorkflow(run.toInvocation().toJSON());
};
