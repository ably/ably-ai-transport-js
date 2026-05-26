/**
 * Transport header builder.
 *
 * Single source of truth for which `x-ably-*` headers every transport
 * message carries. Used by the agent session (addMessages, pipe) and by
 * the client session (optimistic message stamping).
 */

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
} from '../../constants.js';

/**
 * Build the standard transport header set for a message.
 * @param opts - The header values to include.
 * @param opts.role - Message role (e.g. "user", "assistant").
 * @param opts.runId - Run correlation ID.
 * @param opts.codecMessageId - Message identity — the wire `x-ably-codec-message-id` for this message.
 * @param opts.runClientId - ClientId of the run initiator.
 * @param opts.parent - Preceding message's codec-message-id (for branching).
 * @param opts.forkOf - Forked message's codec-message-id (for edit/regen).
 * @param opts.invocationId - Invocation correlation ID. Set on the user-prompt message so the agent can locate the prompt by invocation.
 * @param opts.eventId - Per-event identifier. Set on each client-published user-prompt message; the invocation body's `eventIds` lists the ids the agent should look up.
 * @param opts.runContinue - When `true`, stamps `x-ably-run-continue: 'true'` to mark
 *   the message as a continuation user-message (e.g. a tool-resolution publish under
 *   a suspended run). Continuation user-messages are skipped by the Tree's
 *   winner-rule so the original user-prompt remains visible in materialised history.
 * @returns A headers record with the `x-ably-*` transport headers set.
 */
export const buildTransportHeaders = (opts: {
  role: string;
  runId: string;
  codecMessageId: string;
  runClientId?: string;
  parent?: string;
  forkOf?: string;
  invocationId?: string;
  eventId?: string;
  runContinue?: boolean;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_ROLE]: opts.role,
    [HEADER_RUN_ID]: opts.runId,
    [HEADER_CODEC_MESSAGE_ID]: opts.codecMessageId,
  };
  if (opts.runClientId !== undefined) h[HEADER_RUN_CLIENT_ID] = opts.runClientId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.eventId) h[HEADER_EVENT_ID] = opts.eventId;
  if (opts.runContinue) h[HEADER_RUN_CONTINUE] = 'true';
  return h;
};
