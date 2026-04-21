/**
 * Multi-device continuity — laptop (the resuming device).
 *
 * The laptop opens the same session by name. `session.connect()` hydrates
 * from channel history, so `view.runs` contains the in-flight run the
 * phone started. Aborting from the laptop publishes a durable signal
 * that the next workflow hop picks up via its AIT step — there's no
 * assumption about whether a hop is live at the moment of the abort.
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
export const resumeFromLaptop = async (): Promise<ClientView<AI.UIMessage>> => {
  const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    name: 'session:abc123',
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
 * Global stop from the laptop. Durable abort — the next workflow hop
 * observes it through its AIT step.
 * @param view - The laptop's view of the session.
 * @returns Resolves once the abort signal has been published, if any.
 */
export const onStopClick = async (view: ClientView<AI.UIMessage>): Promise<void> => {
  const active = view.runs.find((r) => r.status === 'active');
  if (active) await active.abort();
};
