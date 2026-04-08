/**
 * Client-side transport types, parameterized by codec event and message types.
 */

import type * as Ably from 'ably';

import type { Logger } from '../../../logger.js';
import type { Codec } from '../../codec/types.js';
import type { CancelFilter, TreeNode, TurnLifecycleEvent } from '../types.js';
export type { TreeNode, TurnLifecycleEvent } from '../types.js';

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
// Active turn handle
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
// Conversation tree
// ---------------------------------------------------------------------------

/**
 * Materializes a branching conversation tree from a flat oplog.
 *
 * Owns the complete conversation state — every node from live messages and
 * history. `flattenNodes()` returns the linear message list for the currently
 * selected branches. Events fire for any change across the full tree.
 */
export interface Tree<TMessage> {
  /**
   * Flatten the tree along the currently selected branches into
   * a linear list of conversation nodes. Each node carries the domain
   * message, its transport-assigned msgId, and headers.
   */
  flattenNodes(): TreeNode<TMessage>[];

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
   * Calling flattenNodes() after this returns the new linear thread.
   * Index is clamped to `[0, siblings.length - 1]`.
   */
  select(msgId: string, index: number): void;

  /** Get a node by msgId, or undefined if not found. */
  getNode(msgId: string): TreeNode<TMessage> | undefined;

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

  // --- Events ---

  /** Active turn IDs grouped by clientId (all turns, not just visible). */
  getActiveTurnIds(): Map<string, Set<string>>;

  /** Subscribe to tree structure changes (insert, update, delete, or branch selection). */
  on(event: 'update', handler: () => void): () => void;

  /** Subscribe to raw Ably messages arriving on the channel. */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;

  /** Subscribe to turn lifecycle events (start and end). */
  on(event: 'turn', handler: (event: TurnLifecycleEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// View — windowed projection over the tree
// ---------------------------------------------------------------------------

/**
 * A paginated, branch-aware projection of the conversation tree.
 *
 * Returns only the visible portion of the selected branch. New live messages
 * appear immediately; older messages are revealed progressively via
 * `loadOlder()`. Events are scoped to the visible window — subscribers
 * are only notified when the visible output changes.
 */
export interface View<TMessage> {
  /** The visible domain messages along the selected branch. Shorthand for `flattenNodes().map(n => n.message)`. */
  getMessages(): TMessage[];

  /** Visible nodes along the selected branch, filtered by the pagination window. */
  flattenNodes(): TreeNode<TMessage>[];

  /** Whether there are older messages that can be loaded or revealed. */
  hasOlder(): boolean;

  /**
   * Reveal older messages. Loads from channel history if the tree doesn't
   * have enough, then advances the window to show up to `limit` more messages.
   * Emits 'update' when the visible list changes.
   * @param limit - Maximum number of older messages to reveal. Defaults to 100.
   */
  loadOlder(limit?: number): Promise<void>;

  /** Active turn IDs for turns with visible messages, grouped by clientId. */
  getActiveTurnIds(): Map<string, Set<string>>;

  /** The visible message list changed (new visible node, branch switch, window shift). */
  on(event: 'update', handler: () => void): () => void;

  /** A raw Ably message arrived that corresponds to a visible node. */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;

  /** A turn event occurred for a turn with visible messages in the window. */
  on(event: 'turn', handler: (event: TurnLifecycleEvent) => void): () => void;

  /** Tear down the view — unsubscribe from tree events and clear internal state. */
  close(): void;
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
  /** The complete conversation tree — all known nodes, events for any change. */
  readonly tree: Tree<TMessage>;

  /** The paginated, branch-aware view for rendering — events scoped to visible messages. */
  readonly view: View<TMessage>;

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

  /** Cancel turns matching the filter. Defaults to `{ own: true }` (all own turns). */
  cancel(filter?: CancelFilter): Promise<void>;

  /**
   * Returns a promise that resolves when all active turns matching the filter
   * have completed. Resolves immediately if no matching turns are active.
   * Defaults to `{ own: true }`.
   */
  waitForTurn(filter?: CancelFilter): Promise<void>;

  /**
   * Subscribe to non-fatal transport errors. These indicate something went
   * wrong but the transport is still operational. Returns an unsubscribe function.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;

  /**
   * Tear down the transport: unsubscribe from the channel, close active
   * streams, clear all handlers, and prevent further operations.
   *
   * Pass `cancel` to publish a cancel message before closing. Without it,
   * only local state is torn down (the server keeps streaming).
   */
  close(options?: CloseOptions): Promise<void>;
}
