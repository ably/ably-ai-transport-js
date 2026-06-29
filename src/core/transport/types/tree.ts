/** Conversation-tree types: nodes, the run-lifecycle event, output events, and the Tree contract. */

import type * as Ably from 'ably';

import type { CodecOutputEvent } from '../../codec/types.js';
import type { RunEndReason, RunStatus, StepEndReason } from './shared.js';

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
  /**
   * Ably server timestamp (epoch ms) of the lifecycle message; absent for an
   * optimistic local event. Advances the Tree's event-log retention clock and
   * the target run's last-activity time.
   */
  timestamp?: number;
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
    } & (
        | {
            /** Why the run ended — any terminal reason other than `'error'`. */
            reason: Exclude<RunEndReason, 'error'>;
          }
        | {
            /** The run ended in error. */
            reason: 'error';
            /**
             * Terminal error detail, reconstructed from the run-end's
             * `error-code` / `error-message` headers (or a generic fallback
             * when the run ended in error without detail). The Tree records it
             * on the RunNode and exposes it via `RunInfo.error`.
             */
            error: Ably.ErrorInfo;
          }
      ));

// ---------------------------------------------------------------------------
// Step lifecycle events
// ---------------------------------------------------------------------------

/**
 * A structured event describing a step attempt starting or ending within a
 * run. A step is a re-attemptable unit of agent execution; the `type`
 * discriminator (`step-start` / `step-end`) is the in-memory domain
 * vocabulary, distinct from the wire message names (`ai-step-start` /
 * `ai-step-end`) it is decoded from.
 *
 * Both arms carry the run-id, the step-id (stable across retry attempts), and
 * the attempt-id (distinct per attempt). The canonical attempt for a step-id
 * is the one whose `step-start` has the latest `serial`; the Tree folds only
 * the canonical attempt's output into the run's projection.
 *
 * Both arms also carry the invocation correlation (`invocationId`) and the
 * three concentric client-identity scopes (`runClientId` ⊃ `invocationClientId`
 * ⊃ `stepClientId`), each an empty string when the wire didn't carry it. The
 * Tree reads `stepClientId` off the canonical step-start into the
 * {@link StepInfo} read-model; the others are carried for consumers correlating
 * step events to a run / invocation / participant.
 */
export type StepLifecycleEvent =
  | {
      /** A step attempt began. */
      type: 'step-start';
      /** The run this step belongs to. */
      runId: string;
      /** The step's id — stable across retry attempts of the same step. */
      stepId: string;
      /** This attempt's id — distinct on every retry of the same step. */
      attemptId: string;
      /**
       * The invocation-id this step was published under (wire `invocation-id`).
       * Correlates the step to the invocation that drove it. Empty string if the
       * wire didn't carry one.
       */
      invocationId: string;
      /**
       * The run owner's clientId (wire `run-client-id`) — the outermost
       * client-identity scope, constant for the run's lifetime. Empty string if
       * the wire didn't carry one.
       */
      runClientId: string;
      /**
       * The clientId of the input that drove the current invocation (wire
       * `input-client-id`) — the middle client-identity scope. Empty string if
       * the wire didn't carry one.
       */
      invocationClientId: string;
      /**
       * The clientId of the participant whose most-recently-incorporated input
       * shapes this step (wire `step-client-id`) — the innermost client-identity
       * scope. Sticky across steps that incorporate no fresh input. Empty string
       * if the wire didn't carry one.
       */
      stepClientId: string;
      /**
       * Ably channel serial of the step-start message, or `undefined` for an
       * optimistic local event. Determines the canonical attempt: the latest
       * serial for a given step-id wins. An undefined serial sorts lowest (an
       * optimistic seed), and the concrete-serial echo promotes it.
       */
      serial: string | undefined;
      /** Ably server timestamp (epoch ms); absent for an optimistic local event. */
      timestamp?: number;
    }
  | {
      /** A step attempt ended. */
      type: 'step-end';
      /** The run this step belongs to. */
      runId: string;
      /** The step's id, matching the corresponding `step-start`. */
      stepId: string;
      /** The attempt's id, matching the corresponding `step-start`. */
      attemptId: string;
      /**
       * The invocation-id this step was published under (wire `invocation-id`).
       * Matches the corresponding `step-start`. Empty string if the wire didn't
       * carry one.
       */
      invocationId: string;
      /**
       * The run owner's clientId (wire `run-client-id`). Matches the
       * corresponding `step-start`. Empty string if the wire didn't carry one.
       */
      runClientId: string;
      /**
       * The clientId of the input that drove the current invocation (wire
       * `input-client-id`). Matches the corresponding `step-start`. Empty string
       * if the wire didn't carry one.
       */
      invocationClientId: string;
      /**
       * The step's client (wire `step-client-id`), matching the corresponding
       * `step-start`. Empty string if the wire didn't carry one.
       */
      stepClientId: string;
      /**
       * Ably channel serial of the step-end message, or `undefined` for an
       * optimistic local event.
       */
      serial: string | undefined;
      /** Ably server timestamp (epoch ms); absent for an optimistic local event. */
      timestamp?: number;
      /** Why the step attempt ended. */
      reason: StepEndReason;
    };

/**
 * A read-model summary of one step within a run, exposed via
 * {@link RunNode.steps}. Reflects the step's **canonical** attempt — the one
 * whose `ai-step-start` has the latest serial.
 */
export interface StepInfo {
  /** The step's id. */
  stepId: string;
  /**
   * The canonical attempt's status: `'active'` while its `ai-step-start` has
   * been seen but no matching `ai-step-end` (including a crashed attempt never
   * retried — the run-level terminal is the signal for that), else the
   * canonical attempt's end reason.
   */
  status: 'active' | StepEndReason;
  /** How many distinct attempts of this step have been observed (deduped by attempt-id). */
  attemptCount: number;
  /**
   * The clientId of the participant whose most-recently-incorporated input
   * shapes this step, read from the canonical attempt's `ai-step-start`
   * `step-client-id` header (the innermost of the three concentric
   * client-identity scopes). Empty string when the canonical step-start carried
   * none, or `undefined` until a step-start has been observed (a step seen only
   * via an out-of-order step-end). Sticky across steps that incorporate no fresh
   * input, so consecutive steps of a single-input turn share one value.
   */
  stepClientId: string | undefined;
}

// ---------------------------------------------------------------------------
// Conversation tree (branching history)
// ---------------------------------------------------------------------------

/**
 * A Run's lifecycle state, modelled as one discriminated value so the terminal
 * `error` is carried exactly when `status` is `'error'`. A RunNode is mutated
 * in place, so status and its dependent error move together — transitions
 * reassign `node.state` wholesale rather than setting fields individually.
 */
export type RunNodeState =
  | {
      /** `'active'` (streaming), `'suspended'` (paused), or a non-error terminal reason. */
      status: Exclude<RunStatus, 'error'>;
    }
  | {
      /** Terminal error status. */
      status: 'error';
      /**
       * The run-end's stamped error (or a generic fallback). Exposed to
       * consumers via `RunInfo.error`.
       */
      error: Ably.ErrorInfo;
    };

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
   * Run lifecycle state — see {@link RunNodeState}. `'active'` until a terminal
   * event; `'suspended'` while paused (a continuation re-activates it);
   * otherwise the run-end reason, carrying `error` when that reason is
   * `'error'`.
   */
  state: RunNodeState;
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
  /**
   * The steps observed within this Run, in first-observed order, each
   * summarising its canonical attempt (see {@link StepInfo}). Output is
   * intrinsic to a step, so a Run that produced any output has at least one
   * (the implicit step a bare `run.pipe` opens lazily on its first output
   * chunk); empty only for a Run that emitted no output. Superseded
   * non-canonical attempts are counted in {@link StepInfo.attemptCount} but not
   * surfaced individually — their output is dropped from {@link projection}.
   */
  steps: readonly StepInfo[];
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
   * The `step-id` of the step that published these outputs, or `undefined`
   * when the carrying message belonged to no step (pre-intrinsic-step history
   * output, or an inputs-only fold). Set from the output's `step-id` header.
   */
  stepId?: string;
  /**
   * The `attempt-id` of the step attempt that published these outputs, or
   * `undefined` when the message belonged to no step. Set from the output's
   * `attempt-id` header. Lets consumers attribute live output to a step
   * attempt; the Tree itself uses it to gate superseded attempts.
   */
  attemptId?: string;
  /**
   * The decoded agent outputs from this message, in wire order. Empty when
   * the folded message carried only inputs (e.g. an optimistic user
   * message), or when the event is a projection-changed signal emitted after
   * a step supersede refold; the event still fires so consumers can observe
   * that the Run's projection changed.
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
  findAblyMessageByEventId(eventId: string): Ably.InboundMessage | undefined;

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
