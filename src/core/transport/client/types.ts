/**
 * Client-side transport types, parameterized by codec event and message types.
 */

import type * as Ably from 'ably';

import type { Logger } from '../../../logger.js';
import type { Codec } from '../../codec/types.js';
import type { CancelFilter, MessageWithHeaders, TurnLifecycleEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Client transport options
// ---------------------------------------------------------------------------

/** Options for creating a client transport. */
export interface ClientTransportOptions<TEvent, TMessage> {
  /** The Ably channel to receive responses on and publish cancel signals to. */
  channel: Ably.RealtimeChannel;

  /** The codec to use for encoding/decoding. */
  codec: Codec<TEvent, TMessage>;

  /** The client's identity. Sent to the server in the POST body. */
  clientId?: string;

  /** Server endpoint URL for the HTTP POST. Defaults to `"/api/chat"`. */
  api?: string;

  /** Headers for the HTTP POST. Function form for dynamic values (e.g. auth tokens). */
  headers?: Record<string, string> | (() => Record<string, string>);

  /** Additional body fields merged into the HTTP POST. Function form for dynamic values. */
  body?: Record<string, unknown> | (() => Record<string, unknown>);

  /** Fetch credentials mode for the HTTP POST. */
  credentials?: RequestCredentials;

  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;

  /** Initial messages to seed the conversation tree with. Forms a linear chain. */
  messages?: TMessage[];

  /** Logger instance for diagnostic output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/** Per-send options for customizing the HTTP POST and branching metadata. */
export interface SendOptions {
  /** Additional fields merged into the HTTP POST body. */
  body?: Record<string, unknown>;
  /** Additional headers for the HTTP POST. */
  headers?: Record<string, string>;
  /**
   * The msg-id of the message this send replaces (fork).
   * Set for regeneration (forkOf an assistant message) or
   * edit (forkOf a user message).
   */
  forkOf?: string;
  /**
   * The msg-id of the message that precedes this one in the
   * conversation thread. Null means the message is a root.
   * If omitted, auto-computed from the last message in the tree.
   */
  parent?: string | null;
}

// ---------------------------------------------------------------------------
// Turn lifecycle events
// ---------------------------------------------------------------------------

/** A handle to an active client-side turn, returned by `send()`, `regenerate()`, and `edit()`. */
export interface ActiveTurn<TEvent> {
  /** The decoded event stream for this turn. */
  stream: ReadableStream<TEvent>;
  /** The turn's unique identifier. */
  turnId: string;
  /** Cancel this specific turn. Publishes a cancel message and closes the local stream. */
  cancel(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Close options
// ---------------------------------------------------------------------------

/** Options for closing a client transport. */
export interface CloseOptions {
  /** Cancel in-progress turns before closing. Publishes a cancel message to the channel. */
  cancel?: CancelFilter;
}

// ---------------------------------------------------------------------------
// History / pagination
// ---------------------------------------------------------------------------

/** A page of decoded messages from channel history. */
export interface PaginatedMessages<TMessage> {
  /** Decoded messages in chronological order (oldest first). */
  items: TMessage[];
  /** Headers for each item, parallel to `items`. Used by the transport to populate the tree. */
  itemHeaders?: Record<string, string>[];
  /** Ably serial for each item, parallel to `items`. Used by the transport for tree ordering. */
  itemSerials?: string[];
  /** Raw Ably messages that produced this page, in chronological order. */
  rawMessages?: Ably.InboundMessage[];
  /** Whether there are older pages available. */
  hasNext(): boolean;
  /** Fetch the next (older) page. Returns undefined if no more pages. */
  next(): Promise<PaginatedMessages<TMessage> | undefined>;
}

/** Options for loading channel history. */
export interface LoadHistoryOptions {
  /** Max messages per page. Default: 100. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Conversation tree (branching history)
// ---------------------------------------------------------------------------

/** A node in the conversation tree, representing a single domain message. */
export interface ConversationNode<TMessage> {
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

/**
 * Materializes a branching conversation tree from a flat oplog.
 *
 * Owns the conversation state — `flatten()` returns the linear message list
 * for the currently selected branches. The transport's `getMessages()` delegates
 * to `flatten()`.
 */
export interface ConversationTree<TMessage> {
  /**
   * Flatten the tree along the currently selected branches into
   * a linear message list. This is what getMessages() returns.
   */
  flatten(): TMessage[];

  /**
   * Get all messages that are siblings (alternatives) at a given
   * fork point. Returns an array ordered chronologically by serial.
   * The message identified by msgId is always included.
   */
  getSiblings(msgId: string): TMessage[];

  /** Whether a message has sibling alternatives (i.e., show navigation arrows). */
  hasSiblings(msgId: string): boolean;

  /** Get the index of the currently selected sibling at a fork point. */
  getSelectedIndex(msgId: string): number;

  /**
   * Select a sibling at a fork point by index. Updates the active branch.
   * Calling flatten() after this returns the new linear thread.
   * Index is clamped to `[0, siblings.length - 1]`.
   */
  select(msgId: string, index: number): void;

  /** Get a node by msgId, or undefined if not found. */
  getNode(msgId: string): ConversationNode<TMessage> | undefined;

  /**
   * Get a node by codec message key (e.g. UIMessage.id), or undefined if
   * not found. Uses a secondary index since the tree is keyed by x-ably-msg-id.
   */
  getNodeByKey(key: string): ConversationNode<TMessage> | undefined;

  /** Get the stored headers for a node by msgId, or undefined if not found. */
  getHeaders(msgId: string): Record<string, string> | undefined;

  // --- Mutation (used by the transport, not the UI) ---

  /**
   * Insert or update a message in the tree. Reads parent/forkOf from the
   * provided headers. If the message already exists (by msgId), updates
   * it in place. The optional serial is the Ably message serial used for
   * deterministic sibling ordering.
   */
  upsert(msgId: string, message: TMessage, headers: Record<string, string>, serial?: string): void;

  /** Remove a message from the tree. */
  delete(msgId: string): void;
}

// ---------------------------------------------------------------------------
// Internal sub-component types
// ---------------------------------------------------------------------------

/** Entry in the StreamRouter's turn map. Not part of the public API. */
export interface TurnEntry<TEvent> {
  /** The ReadableStream controller for this turn. */
  controller: ReadableStreamDefaultController<TEvent>;
  /** The turn's unique identifier. */
  turnId: string;
}

// ---------------------------------------------------------------------------
// Client transport interface
// ---------------------------------------------------------------------------

/** Client-side transport that manages conversation state over an Ably channel. */
export interface ClientTransport<TEvent, TMessage> {
  /**
   * Send one or more messages and start a new turn. Returns a handle to the
   * active turn with the decoded event stream and a cancel function.
   *
   * The HTTP POST is fire-and-forget — the returned stream is available
   * immediately. If the POST fails, the error is surfaced via `on("error")`.
   */
  send(messages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveTurn<TEvent>>;

  /**
   * Regenerate an assistant message. Creates a new turn that forks the
   * target message with no new user messages. Automatically computes
   * `forkOf`, `parent`, and truncated `history` from the tree.
   *
   * Pass `options.body.history` to override the default truncated history.
   */
  regenerate(messageId: string, options?: SendOptions): Promise<ActiveTurn<TEvent>>;

  /**
   * Edit a user message. Creates a new turn that forks the target message
   * with replacement content. Automatically computes `forkOf`, `parent`,
   * and `history` from the tree.
   */
  edit(messageId: string, newMessages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveTurn<TEvent>>;

  /**
   * Access the conversation tree for branch navigation.
   * The tree is updated in real-time by the transport's channel subscription.
   */
  getTree(): ConversationTree<TMessage>;

  /** Cancel turns matching the filter. Defaults to `{ own: true }` (all own turns). */
  cancel(filter?: CancelFilter): Promise<void>;

  /**
   * Returns a promise that resolves when all active turns matching the filter
   * have completed. Resolves immediately if no matching turns are active.
   * Defaults to `{ own: true }`.
   */
  waitForTurn(filter?: CancelFilter): Promise<void>;

  /**
   * Subscribe to message store changes or raw Ably message additions.
   * The handler is called with no arguments — call `getMessages()` or
   * `getAblyMessages()` for the current state. Returns an unsubscribe function.
   */
  on(event: 'message' | 'ably-message', handler: () => void): () => void;

  /** Subscribe to turn lifecycle events (start, end). Returns an unsubscribe function. */
  on(event: 'turn', handler: (event: TurnLifecycleEvent) => void): () => void;

  /**
   * Subscribe to non-fatal transport errors. These indicate something went
   * wrong but the transport is still operational. Returns an unsubscribe function.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;

  /**
   * Get the accumulated raw Ably messages, in chronological order.
   * Includes both live messages and history-loaded messages.
   */
  getAblyMessages(): Ably.InboundMessage[];

  /** Get all currently active turns, keyed by clientId. */
  getActiveTurnIds(): Map<string, Set<string>>;

  /** Get Ably headers associated with a message via the conversation tree. */
  getMessageHeaders(message: TMessage): Record<string, string> | undefined;

  /** Get the current message list (follows selected branches). Updated by message lifecycle events. */
  getMessages(): TMessage[];

  /**
   * Snapshot the current message list as message + headers pairs.
   * Convenience for building the `history` body field in HTTP POSTs.
   */
  getMessagesWithHeaders(): MessageWithHeaders<TMessage>[];

  /**
   * Load a page of conversation history from the channel, decoded through
   * the transport's codec. Uses `untilAttach` for gapless continuity with
   * the live subscription.
   *
   * History messages are inserted into the conversation tree and trigger
   * a notification. Returns a PaginatedMessages handle — call `next()`
   * for older pages.
   */
  history(options?: LoadHistoryOptions): Promise<PaginatedMessages<TMessage>>;

  /**
   * Tear down the transport: unsubscribe from the channel, close active
   * streams, clear all handlers, and prevent further operations.
   *
   * Pass `cancel` to publish a cancel message before closing. Without it,
   * only local state is torn down (the server keeps streaming).
   */
  close(options?: CloseOptions): Promise<void>;
}
