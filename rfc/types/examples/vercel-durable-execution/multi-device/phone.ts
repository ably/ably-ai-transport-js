/**
 * Multi-device continuity — phone (the initiating device).
 *
 * The user starts a long-running research task from their phone and puts
 * it down. The run is durable on the channel, so the laptop (see
 * ./laptop.ts) can hydrate and observe the same state minutes later.
 * The workflow runs independently of both devices under Vercel's Workflow
 * DevKit; its hops publish through AIT as they complete.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

import type { Codec, InvocationData } from '../../../index.js';
import { createClientSession } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;

/**
 * Deliver an invocation to the workflow HTTP trigger.
 * @param data - The {@link InvocationData} produced by `run.createInvocation().toJSON()`.
 * @returns Resolves once the POST has been dispatched.
 */
const invokeWorkflow = async (data: InvocationData): Promise<void> => {
  await fetch('/api/workflow/start', { method: 'POST', body: JSON.stringify(data) });
};

/**
 * Kick off a long-running research run from the phone. The phone doesn't
 * need to stay connected — the session state lives on the channel and the
 * workflow progresses independently.
 * @param text - The user's initial prompt.
 * @returns Resolves once the invocation has been dispatched.
 */
export const startFromPhone = async (text: string): Promise<void> => {
  const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    name: 'session:abc123',
    codec,
  });
  await session.connect();

  const view = session.createView();
  const run = view.createRun();
  await run.start();
  await run.send({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
  await invokeWorkflow(run.createInvocation().toJSON());
};
