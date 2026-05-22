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
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_PROMPT_ID,
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
 * @param opts.msgId - Message identity — the wire `x-ably-msg-id` for this message.
 * @param opts.runClientId - ClientId of the run initiator.
 * @param opts.parent - Preceding message's msg-id (for branching).
 * @param opts.forkOf - Forked user-prompt's msg-id (for edits — creates a Run-level fork sibling).
 * @param opts.regenerates - Assistant msg-id this run regenerates. Stamps
 *   `x-ably-msg-regenerate`. Distinct from `forkOf`: regenerate is a
 *   continuation of the prior run (no Run-level fork), with the message
 *   replacement resolved at projection extraction time.
 * @param opts.invocationId - Invocation correlation ID. Set on the user-prompt message so the agent can locate the prompt by invocation.
 * @param opts.promptId - Per-prompt identifier. Set on each client-published user-prompt message; the invocation body's `promptIds` lists the ids the agent should look up.
 * @param opts.runContinue - When `true`, stamps `x-ably-run-continue: 'true'` to mark
 *   the message as a continuation user-message (e.g. a tool-resolution publish under
 *   a suspended run). Continuation user-messages are skipped by the Tree's
 *   winner-rule so the original user-prompt remains visible in materialised history.
 * @returns A headers record with the `x-ably-*` transport headers set.
 */
export const buildTransportHeaders = (opts: {
  role: string;
  runId: string;
  msgId: string;
  runClientId?: string;
  parent?: string;
  forkOf?: string;
  regenerates?: string;
  invocationId?: string;
  promptId?: string;
  runContinue?: boolean;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_ROLE]: opts.role,
    [HEADER_RUN_ID]: opts.runId,
    [HEADER_MSG_ID]: opts.msgId,
  };
  if (opts.runClientId !== undefined) h[HEADER_RUN_CLIENT_ID] = opts.runClientId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.regenerates) h[HEADER_MSG_REGENERATE] = opts.regenerates;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.promptId) h[HEADER_PROMPT_ID] = opts.promptId;
  if (opts.runContinue) h[HEADER_RUN_CONTINUE] = 'true';
  return h;
};
