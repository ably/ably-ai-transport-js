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
// Message with headers
// ---------------------------------------------------------------------------

/** A domain message paired with its Ably transport headers. Used on the read path to snapshot conversation state (e.g. for HTTP POST bodies). */
export interface MessageWithHeaders<TMessage> {
  /** The domain message. */
  message: TMessage;
  /** Ably headers associated with this message (transport metadata, domain headers). */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Turn lifecycle events
// ---------------------------------------------------------------------------

/** A structured event describing a turn starting or ending. */
export type TurnLifecycleEvent =
  | { type: 'x-ably-turn-start'; turnId: string; clientId: string }
  | { type: 'x-ably-turn-end'; turnId: string; clientId: string; reason: TurnEndReason };
