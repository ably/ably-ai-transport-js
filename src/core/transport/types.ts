/**
 * Shared transport types used by both client and server.
 *
 * Client-specific types live in `./client/types.ts`.
 * Server-specific types live in `./server/types.ts`.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Why a turn ended. */
export type TurnEndReason = 'complete' | 'cancelled' | 'error';

/** Filter for cancel operations. At most one field should be set. */
export interface CancelFilter {
  /** Cancel a specific turn by ID. */
  turnId?: string;
  /** Cancel all turns belonging to the sender's clientId. */
  own?: boolean;
  /** Cancel all turns belonging to a specific clientId. */
  clientId?: string;
  /** Cancel all turns on the channel. */
  all?: boolean;
}

// ---------------------------------------------------------------------------
// Conversation tree node
// ---------------------------------------------------------------------------

/** A node in the conversation tree, representing a single domain message. */
export interface TreeNode<TMessage> {
  /** The domain message. */
  message: TMessage;
  /** The x-ably-msg-id of this node — primary key in the tree. */
  msgId: string;
  /** Parent node's msg-id (x-ably-parent), or undefined for root messages. */
  parentId: string | undefined;
  /** The msg-id this node forks from (x-ably-fork-of), or undefined if first version. */
  forkOf: string | undefined;
  /** Full Ably headers for this message. */
  headers: Record<string, string>;
  /**
   * Ably serial for this message. Lexicographically comparable for total order.
   * Used to sort siblings deterministically regardless of delivery/history order.
   * Absent for optimistic messages (set when the server relay arrives).
   */
  serial: string | undefined;
}

// ---------------------------------------------------------------------------
// Turn lifecycle events
// ---------------------------------------------------------------------------

/** A structured event describing a turn starting or ending. */
export type TurnLifecycleEvent =
  | { type: 'x-ably-turn-start'; turnId: string; clientId: string }
  | { type: 'x-ably-turn-end'; turnId: string; clientId: string; reason: TurnEndReason };
