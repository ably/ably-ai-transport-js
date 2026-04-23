/**
 * Multi-device continuity — laptop (the resuming device).
 *
 * The laptop opens the same session by name. `session.connect()` hydrates
 * from channel history, so `view.runs` contains the in-flight run the
 * phone started. The user can abort from the laptop — either globally or
 * per-message — and the signal reaches the serverless agent through the
 * same durable control surface as any other abort.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

import type { ClientView, Codec } from '../../../index.js';
import { createClientSession } from '../../../index.js';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;

/**
 * Resume the same session from the laptop and subscribe to view changes.
 * @returns The laptop's live view of the shared session.
 */
export const resumeFromLaptop = async (): Promise<ClientView<Codec<AI.UIMessageChunk, AI.UIMessage>>> => {
  const session = createClientSession({
    client: ably,
    sessionName: 'session:abc123',
    codec,
  });
  await session.connect(); // hydrates from channel history

  const view = session.createView();
  view.subscribe(() => {
    // UI reads view.messages and view.runs to render the conversation.
  });
  return view;
};

/**
 * Global stop from the laptop. The in-flight run observed during hydration
 * is abortable from here — either globally or by calling
 * `node.run?.abort()` on a specific rendered message.
 * @param view - The laptop's view of the session.
 * @returns Resolves once the abort signal has been published and the
 *   wake-up invocation POST has been dispatched, if any.
 */
export const onStopClick = async (view: ClientView<Codec<AI.UIMessageChunk, AI.UIMessage>>): Promise<void> => {
  const active = view.runs.find((r) => r.status === 'active');
  if (!active) return;
  const invocation = await active.abort();
  void fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};
