import type { Run } from './run.js';
import type { StepState } from './step.js';

/**
 * A node in the session's conversation tree. Carries the domain message
 * plus transport metadata (identity, attribution, structure) and the run
 * the message belongs to, typed to the session's run variant so per-message
 * controls are directly callable from the rendered node.
 */
export interface MessageNode<TMessage, TRun extends Run<TMessage> = Run<TMessage>> {
  /** Unique message ID (from the `x-ably-msg-id` header). */
  readonly id: string;

  /** The domain message in the codec's representation. */
  readonly message: TMessage;

  /**
   * The participant type that produced this message (from the `x-ably-role`
   * header). Client-initiated publishes are `user`; agent-initiated publishes
   * are `assistant`. This is the protocol role, which may differ from the
   * role the codec encodes inside the domain message — use this when filtering
   * or attributing at the transport level.
   */
  readonly role: 'user' | 'assistant';

  /**
   * The clientId this message is attributed to. Taken from the
   * `x-ably-client-id` header when present (a backend publishing on behalf
   * of an end-user), otherwise from the publishing connection's
   * `message.clientId`. Use this for UI attribution, access checks, and
   * filtering to a specific user's activity.
   */
  readonly clientId: string;

  /**
   * The run this message belongs to. Typed to the session's run variant:
   * `ClientRun<TMessage>` when this node comes from a ClientSession's tree
   * or view, `AgentRun<TMessage>` when it comes from an AgentSession. So
   * `node.run?.abort()`, `node.run?.send(...)`, etc. are directly callable
   * from the rendered node — no need to look up by ID through `view.runs`.
   *
   * Undefined only when the node represents a message published before any
   * run was observed (e.g. during mid-hydration).
   */
  readonly run?: TRun;

  /**
   * The step that produced this message, if any. Only present on
   * agent-published messages. Use step.status to filter out messages
   * from non-complete steps (failed, abandoned, superseded).
   */
  readonly step?: StepState;

  /** Whether any part of this message is still being streamed. */
  readonly streaming: boolean;

  /** Parent message ID in the tree. Undefined for root messages. */
  readonly parentId?: string;

  /** Child message IDs (branches). Empty for leaf messages. */
  readonly children: readonly string[];
}
