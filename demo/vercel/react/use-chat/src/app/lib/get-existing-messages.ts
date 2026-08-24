/**
 * getExistingMessages — the demo's swappable history source for the agent
 * route's model context: page the transport's channel history to exhaustion
 * and fold it through the demo's fold helper. Swapping the channel for a
 * database later means reimplementing only this function.
 */

import type { UIMessage } from 'ai';
import type { AgentTransport, TransportEvent } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';

import { foldMessages } from './fold-messages';

/**
 * Page the whole existing conversation off the channel and fold it.
 * @param transport - A connected transport whose `history()` to page.
 * @returns The folded conversation, oldest message first.
 */
export const getExistingMessages = async (
  transport: Pick<AgentTransport<VercelInput, VercelOutput>, 'history'>,
): Promise<UIMessage[]> => {
  // Each history() call returns the next older batch, so prepend.
  let events: TransportEvent<VercelInput, VercelOutput>[] = [];
  let exhausted = false;
  while (!exhausted) {
    const batch = await transport.history();
    events = [...batch.events, ...events];
    exhausted = batch.exhausted;
  }
  return foldMessages(events);
};
