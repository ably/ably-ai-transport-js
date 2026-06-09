/** Conversation-tree types: nodes, the run-lifecycle event, output events, and the Tree contract. */

import type * as Ably from 'ably';

import type { CodecOutputEvent } from '../../codec/types.js';
import type { RunEndReason } from './shared.js';

// ---------------------------------------------------------------------------
// Run lifecycle events
// ---------------------------------------------------------------------------

/**
 * Fields common to every {@link RunLifecycleEvent} arm.
 */
interface RunLifecycleBase {
  /** The run-id this lifecycle event concerns. */
  runId: string;
  /** The owning client's identity (Ably publisher `clientId`). */
  clientId: string;
  /**
   * The invocation-id this lifecycle event was published under (wire
   * `invocation-id`). Lets consumers correlate the run's lifecycle back to the
   * invocation that drove it; on a run-start the Tree records it on the RunNode
   * at first creation so an optimistic Run exposes the invocation synchronously.
   * Empty string if the wire didn't carry an invocation-id.
   */
  invocationId: string;
}

/**
 * A structured event describing a run starting, suspending, resuming, or
 * ending. The `type` discriminator (`start` / `suspend` / `resume` / `end`) is
 * the in-memory domain vocabulary and is intentionally distinct from the wire
 * message names (`ai-run-start` / `ai-run-suspend` / `ai-run-resume` /
 * `ai-run-end`) those events are decoded from.
 */
export type RunLifecycleEvent =
  | (RunLifecycleBase & {
      type: 'start';
      /**
       * Ably channel serial of the run-start message, or `undefined` for an
       * optimistic local event (no serial assigned yet). The Tree reads it to
       * promote the Run's startSerial.
       */
      serial: string | undefined;
      /** The codec-message-id of the parent message, if known. Omitted for root runs. */
      parent?: string;
      /**
       * The codec-message-id of the user prompt being forked, when the run is an
       * edit. Carried verbatim from the `fork-of` wire header.
       */
      forkOf?: string;
      /**
       * The codec-message-id of the assistant message this run regenerates, when
       * the run is a regenerate continuation. Carried verbatim from the
       * `msg-regenerate` wire header. The Tree treats regenerates
       * as continuations (no `forkOf` at the Run level) — the View
       * realises the replacement when materialising messages.
       */
      regenerates?: string;
    })
  | (RunLifecycleBase & {
      type: 'suspend';
      /**
       * Ably channel serial of the run-suspend message, or `undefined` for an
       * optimistic local event. The Tree reads it to set the Run's endSerial
       * (a suspended run carries the serial at which it paused).
       */
      serial: string | undefined;
    })
  | (RunLifecycleBase & {
      type: 'resume';
      /**
       * Ably channel serial of the run-resume message, or `undefined` for an
       * optimistic local event. A resume re-enters an existing run; it does not
       * promote the Run's startSerial (the original run-start owns that).
       */
      serial: string | undefined;
    })
  | (RunLifecycleBase & {
      type: 'end';
      /**
       * Ably channel serial of the run-end message, or `undefined` for an
       * optimistic local event. The Tree reads it to set the Run's endSerial.
       */
      serial: string | undefined;
      /**
       * Why the run ended — the terminal reason the Tree records as the
       * RunNode's status: `complete`, `cancelled`, or `error`.
       */
      reason: RunEndReason;
    });

// ---------------------------------------------------------------------------
// Conversation tree (branching history)
// ---------------------------------------------------------------------------

/** A node in the conversation tree, representing a single domain message. */
export interface MessageNode<TMessage> {
  /** Discriminator — identifies this as a message node. */
  kind: 'message';
  /** The domain message. */
  message: TMessage;
  /** The codec-message-id of this node — primary key in the tree. */
  codecMessageId: string;
  /** Parent node's codec-message-id (parent), or undefined for root messages. */
  parentId: string | undefined;
  /** The codec-message-id this node forks from (fork-of), or undefined if first version. */
  forkOf: string | undefined;
  /** The transport-tier headers (`extras.ai.transport`) for this message: the run/stream/identity/branching headers set and read by the transport layer. Codec-tier headers (`extras.ai.codec`) are not included. */
  headers: Record<string, string>;
  /**
   * Ably serial for this message. Lexicographically comparable for total order.
   * Used to sort siblings deterministically regardless of delivery/history order.
   * Absent for optimistic messages (set when the server relay arrives).
   */
  serial: string | undefined;
}

/**
 * A node in the conversation tree, representing a single Run.
 *
 * A RunNode is keyed by its agent-minted `runId`. Each RunNode owns a per-Run
 * codec {@link TProjection} folded from every event published under that
 * run-id; the SDK extracts the per-message list via {@link Codec.getMessages}
 * when it needs to render messages for that Run.
 *
 * A regenerate is a sibling reply run: it shares its input-node parent
 * ({@link parentCodecMessageId}) with the original reply, so same-parent reply
 * runs form the regenerate group with no `forkOf` involved. (Editing a prompt
 * instead produces a sibling {@link InputNode} via that node's `forkOf`.)
 */
export interface RunNode<TProjection> {
  /** Discriminator — identifies this as a reply-run node within {@link ConversationNode}. */
  kind: 'run';
  /** The run-id of this Run — primary key in the tree. */
  runId: string;
  /**
   * The codec-message-id this Run is rooted at — the `parent` header of the
   * first observed message (or the run-start lifecycle event's `parent`
   * field). This is the run's input node's codec-message-id: the user prompt
   * the agent replied to. The Tree uses it for kind-blind reachability and to
   * build the input→reply edge. `undefined` for the root Run.
   */
  parentCodecMessageId: string | undefined;
  /**
   * The node key of the node this Run replaces, or `undefined` if this Run is
   * not a fork. Populated when the wire's `fork-of` header points at a
   * codec-message-id that has been observed; the Tree resolves it through the
   * codec-message-id → node-key index. Reply-run regenerate siblings do not
   * use this (they group by shared parent) — it carries an explicit fork link
   * when the wire stamps one.
   */
  forkOf: string | undefined;
  /**
   * The codec-message-id this Run regenerates, or `undefined` for non-regenerate
   * Runs. Populated from the wire's `msg-regenerate` header (and the lifecycle
   * event's `regenerates` field) verbatim — the Tree does not resolve it to a
   * node key because the anchor is a message position, not a node.
   *
   * A regenerate run parents at the SAME input node as the reply it
   * regenerates, so it joins that input's reply runs as a same-parent sibling;
   * the message named by `regeneratesCodecMessageId` is replaced by this Run's
   * content when the View materialises the chain into messages (Spec: AIT-CT13d).
   */
  regeneratesCodecMessageId: string | undefined;
  /**
   * Identity of the Ably client that started this Run, sourced from the
   * `run-client-id` wire header (or the run-start lifecycle event's
   * `clientId` field). Set once at Run creation and never updated; persists
   * through the Run's lifecycle, including after `run-end`. Empty string if
   * the wire didn't carry a client id.
   */
  clientId: string;
  /**
   * Run lifecycle status.
   * - `'active'` — run-start observed, no terminal event yet.
   * - `'suspended'` — run-suspend observed; the run is paused awaiting input
   *   and stays live (a continuation re-activates it). Not terminal.
   * - {@link RunEndReason} — terminal state reflecting the run-end reason.
   */
  status: 'active' | 'suspended' | RunEndReason;
  /** Per-Run codec projection. Folded by the Tree from every event published under this run-id. */
  projection: TProjection;
  /**
   * The agent-minted invocationId observed for this Run (wire `invocation-id`).
   * The agent mints it, so an optimistic Run starts with an empty id; it is
   * adopted from the agent's `ai-run-start` (or set at creation when the Run is
   * first seen from a wire event carrying one) and never reassigned thereafter.
   * Empty string until run-start arrives, or if the wire didn't carry an
   * invocation-id.
   */
  invocationId: string;
  /** Ably serial of the first observed message tagged with this run-id. Absent for optimistic Runs. */
  startSerial: string | undefined;
  /** Ably serial of the run-end lifecycle event, if observed. */
  endSerial: string | undefined;
}

/**
 * A node in the conversation tree, representing a single user input (prompt).
 *
 * An input node owns the user's prompt for one turn. It is keyed by the
 * client-owned `codec-message-id` and never carries a run-id — the agent mints
 * the run-id for the reply, which becomes a separate {@link RunNode} parented to
 * this input node. An edit of a prompt is a sibling input node (via `forkOf`).
 *
 * Like a {@link RunNode}, it carries its own per-input codec {@link TProjection}
 * folded from the input event(s) published under its codec-message-id; the SDK
 * extracts the per-message list via {@link Codec.getMessages} when rendering.
 */
export interface InputNode<TProjection> {
  /** Discriminator — identifies this as an input node within {@link ConversationNode}. */
  kind: 'input';
  /** The codec-message-id of this input — primary key in the tree. */
  codecMessageId: string;
  /**
   * The codec-message-id of the node this input hangs off (its structural
   * parent — the immediately preceding reply run on this chain), or `undefined`
   * for the first input in a conversation. Used for kind-blind tree
   * reachability alongside {@link RunNode.parentCodecMessageId}.
   */
  parentCodecMessageId: string | undefined;
  /**
   * The codec-message-id this input forks from when it is an edit of an earlier
   * prompt, or `undefined` if it is the first version. Sibling input nodes
   * (alternate prompts) share the same `forkOf` anchor.
   */
  forkOf: string | undefined;
  /** Per-input codec projection. Folded by the Tree from every input event published under this codec-message-id. */
  projection: TProjection;
  /** Ably serial of the first observed message for this input. Absent for optimistic (locally-created) inputs. */
  serial: string | undefined;
}

/**
 * A node in the conversation tree: either a user {@link InputNode} or an agent
 * {@link RunNode}. Narrow on `kind` (`'input'` vs `'run'`) before reading
 * kind-specific fields.
 */
export type ConversationNode<TProjection> = InputNode<TProjection> | RunNode<TProjection>;

/**
 * Payload of the Tree's `output` event: the decoded agent outputs folded
 * for a Run from a single inbound message, carrying the routing metadata a
 * consumer needs to attribute or stream them.
 */
export interface OutputEvent<TOutput extends CodecOutputEvent> {
  /**
   * The runId the outputs were folded into, or `undefined` when the fold was
   * into a user input node (which carries no run-id — the agent mints run-ids).
   * An input fold always has empty {@link events}; consumers route by
   * {@link inputCodecMessageId}, not this.
   */
  runId: string | undefined;
  /**
   * The codec-message-id of the input event that triggered this run — the
   * agent's `input-codec-message-id` header. This is the stable key the client
   * owns from send time (before the agent mints the runId), so the output
   * stream can attribute outputs to the request that produced them. Distinct
   * from {@link runId}: causal (which input produced these outputs) rather than
   * the run's own identity. `undefined` when the carrying message had no such
   * header — e.g. a purely-optimistic local fold with no wire echo yet.
   */
  inputCodecMessageId: string | undefined;
  /**
   * The `codec-message-id` the outputs were published under, or `undefined`
   * when the message carried none.
   */
  codecMessageId: string | undefined;
  /**
   * Ably channel serial of the message that carried the outputs, or
   * `undefined` for an optimistic local fold (no serial assigned yet).
   */
  serial: string | undefined;
  /**
   * The decoded agent outputs from this message, in wire order. Empty when
   * the folded message carried only inputs (e.g. an optimistic user
   * message); the event still fires so consumers can observe that the Run's
   * projection changed.
   */
  events: TOutput[];
}

/**
 * Materializes a branching conversation tree from a flat oplog of Ably
 * messages. Each turn is two nodes: a user {@link InputNode} keyed by its
 * client-owned codec-message-id and an agent {@link RunNode} keyed by the
 * agent-minted run-id, parented to the input node.
 *
 * The Tree owns the complete conversation state across every observed node.
 * Each node holds a per-node codec {@link TProjection} which the Tree folds
 * from inbound events. The View walks the parent chain to extract a flat
 * message list for rendering.
 */
export interface Tree<TOutput extends CodecOutputEvent, TProjection> {
  /** Get a Run by runId, or undefined if not found. */
  getRunNode(runId: string): RunNode<TProjection> | undefined;

  /**
   * Get the node that owns a given codec-message-id (via the Tree's
   * codecMessageId index), or undefined if the codec-message-id hasn't been
   * observed. The result is a {@link ConversationNode} union: narrow on `kind`
   * (`'input'` vs `'run'`) before reading kind-specific fields.
   */
  getNodeByCodecMessageId(codecMessageId: string): ConversationNode<TProjection> | undefined;

  /**
   * Get the sibling group (both kinds) the node keyed by `key` belongs to:
   * edit versions for an input node (forkOf-linked, same parent), regenerate
   * runs for a reply run (same input-node parent). Ordered oldest-first by
   * serial; a single-element array when the node has no siblings. Empty when
   * `key` is unknown. Narrow each node on `kind` before reading kind-specific
   * fields.
   * @param key - The node key ({@link RunNode.runId} or {@link InputNode.codecMessageId}).
   * @returns The ordered sibling nodes.
   */
  getSiblingNodes(key: string): ConversationNode<TProjection>[];

  /**
   * Look up the raw Ably message that carried the given `event-id` header,
   * if the Tree has observed it. Populated incrementally as messages arrive
   * through the Tree's `ably-message` channel; not bounded except by the
   * Tree's lifetime. Used by the agent's input-event lookup to find a
   * triggering input message by id without scanning a separate buffer.
   * @param eventId - The `event-id` header value to look up.
   * @returns The matching raw Ably message, or undefined when the Tree has
   *   not observed an event with that id.
   */
  findWireByEventId(eventId: string): Ably.InboundMessage | undefined;

  // --- Events ---

  /**
   * Subscribe to tree structural changes (Run insert, delete, sort-reorder,
   * startSerial promotion, run-start metadata backfill). Does NOT fire on
   * content-only folds (streaming chunks) or on run-end status changes —
   * those flow through `output` and `run` respectively.
   */
  on(event: 'update', handler: () => void): () => void;

  /** Subscribe to raw Ably messages arriving on the channel. */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;

  /** Subscribe to run lifecycle events (start, suspend, resume, and end). */
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;

  /**
   * Subscribe to decoded agent outputs as they are folded into a Run.
   * Fires once per inbound message after its fold, carrying the message's
   * output events plus routing metadata (runId, codec-message-id, serial).
   * Fires with an empty `events` array for inputs-only folds so it can also
   * serve as a projection-changed signal.
   */
  on(event: 'output', handler: (event: OutputEvent<TOutput>) => void): () => void;
}
