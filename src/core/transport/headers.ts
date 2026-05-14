/**
 * Transport header builder.
 *
 * Single source of truth for which `x-ably-*` headers every transport
 * message carries. Used by the agent session (addMessages, pipe) and by
 * the client session (optimistic message stamping).
 */

import {
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
} from '../../constants.js';

/**
 * Build the standard transport header set for a message.
 * @param opts - The header values to include.
 * @param opts.role - Message role (e.g. "user", "assistant").
 * @param opts.runId - Run correlation ID.
 * @param opts.msgId - Message identity. Set to the original message's id when
 *   publishing an event that modifies an existing message (client tool output,
 *   approval response) — the reducer routes events by `meta.messageId`.
 * @param opts.runClientId - ClientId of the run initiator.
 * @param opts.parent - Preceding message's msg-id (for branching).
 * @param opts.forkOf - Forked message's msg-id (for edit/regen).
 * @param opts.invocationId - Invocation correlation ID. Set on the user-prompt message so the agent can locate the prompt by invocation.
 * @returns A headers record with the `x-ably-*` transport headers set.
 */
export const buildTransportHeaders = (opts: {
  role: string;
  runId: string;
  msgId: string;
  runClientId?: string;
  parent?: string;
  forkOf?: string;
  invocationId?: string;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_ROLE]: opts.role,
    [HEADER_RUN_ID]: opts.runId,
    [HEADER_MSG_ID]: opts.msgId,
  };
  if (opts.runClientId !== undefined) h[HEADER_RUN_CLIENT_ID] = opts.runClientId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  return h;
};
