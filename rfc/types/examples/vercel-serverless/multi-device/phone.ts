/**
 * Multi-device continuity — phone (the initiating device).
 *
 * The user starts a long-running research task from their phone and puts
 * it down. The run is durable on the channel, so the laptop (see
 * ./laptop.ts) can hydrate and observe the same state minutes later.
 * The serverless agent endpoint runs the work independently of both
 * devices.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createClientSession } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;

/**
 * Deliver an invocation to the agent HTTP endpoint.
 * @param data - The {@link InvocationData} produced by `run.toInvocation().toJSON()`.
 * @returns Resolves once the POST has been dispatched.
 */
const invokeAgent = async (data: InvocationData): Promise<void> => {
  await fetch('/api/agent', { method: 'POST', body: JSON.stringify(data) });
};

/**
 * Kick off a long-running research run from the phone. The phone doesn't
 * need to stay connected — the session state lives on the channel.
 * @param text - The user's initial prompt.
 * @returns Resolves once the invocation has been dispatched.
 */
export const startFromPhone = async (text: string): Promise<void> => {
  const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: 'session:abc123',
    codec,
  });
  await session.connect();

  const view = session.createView();
  const run = view.createRun();
  await run.start();
  await run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
  await invokeAgent(run.toInvocation().toJSON());
};
