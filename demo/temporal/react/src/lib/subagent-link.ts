/**
 * Wire contract for the demo's subagent-link sidecar message. The parent
 * workflow publishes one of these onto the shared session channel right
 * after seeding the subagent's run, so any subscriber (the live UI, a
 * late-joining client hydrating from history) can reconstruct the
 * parent→child run tree.
 *
 * The link is demo-only metadata — AIT itself has no notion of parent
 * runs; runs are flat. Carrying it on a separate message name keeps the
 * SDK's wire shape clean while still flowing through the same channel,
 * which is the demo's whole point (one shared session, full state
 * hydratable).
 */

/**
 * Ably message name carrying {@link SubagentLink} payloads on the session
 * channel.
 */
export const SUBAGENT_LINK_MESSAGE_NAME = 'demo:subagent-link';

/**
 * Payload published under {@link SUBAGENT_LINK_MESSAGE_NAME} when a parent
 * agent spawns a subagent.
 */
export interface SubagentLink {
  /** The subagent's runId (the child run on the shared channel). */
  runId: string;
  /** The runId of the parent that spawned this subagent. */
  parentRunId: string;
  /**
   * The toolCallId of the parent's `spawn_subagent` tool call that
   * produced this subagent. The UI uses this to locate the parent's
   * assistant message + tool-call part and nest the subagent under it.
   */
  parentToolCallId: string;
  /** Short human-readable label from the spawn_subagent input. */
  description: string;
}
