/**
 * Transport header builder.
 *
 * Single source of truth for which `x-ably-*` headers every transport
 * message carries. Used by the server transport (addMessages, streamResponse)
 * and will be used by the client transport (optimistic message stamping).
 */

import {
  HEADER_FORK_OF,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_TURN_CLIENT_ID,
  HEADER_TURN_ID,
} from '../../constants.js';

/**
 * Build the standard transport header set for a message.
 * @param opts - The header values to include.
 * @param opts.role - Message role (e.g. "user", "assistant").
 * @param opts.turnId - Turn correlation ID.
 * @param opts.msgId - Message identity.
 * @param opts.turnClientId - ClientId of the turn initiator.
 * @param opts.parent - Preceding message's msg-id (for branching). Null means root.
 * @param opts.forkOf - Forked message's msg-id (for edit/regen).
 * @returns A headers record with the `x-ably-*` transport headers set.
 */
export const buildTransportHeaders = (opts: {
  role: string;
  turnId: string;
  msgId: string;
  turnClientId?: string;
  parent?: string | null;
  forkOf?: string;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_ROLE]: opts.role,
    [HEADER_TURN_ID]: opts.turnId,
    [HEADER_MSG_ID]: opts.msgId,
  };
  if (opts.turnClientId !== undefined) h[HEADER_TURN_CLIENT_ID] = opts.turnClientId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  return h;
};
