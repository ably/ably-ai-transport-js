/**
 * getExistingMessages — the model context for one turn.
 *
 * The store is the conversation, and the channel carries what has happened
 * since the last write: the input that woke this invocation. So the context is
 * the stored messages with that one input applied (see `apply-input.ts`). No
 * channel history is paged, by either the agent or the client — the store is
 * the demo's whole record.
 */

import type { UIMessage } from 'ai';
import type { LocatedInput } from '@ably/ai-transport';
import type { VercelInput } from '@ably/ai-transport/vercel';

import { applyInputs } from './apply-input';
import { loadConversation } from './message-store';

/**
 * Build the conversation for the model from the store and the triggering input.
 * @param channelName - The conversation key (the channel name).
 * @param located - The input that woke this invocation.
 * @returns The conversation, oldest message first.
 */
export const getExistingMessages = async (
  channelName: string,
  located: LocatedInput<VercelInput>,
): Promise<UIMessage[]> => applyInputs(loadConversation(channelName).messages, located.inputs);
