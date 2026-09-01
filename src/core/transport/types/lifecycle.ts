/**
 * Run and step lifecycle events: the parsed, in-memory form of the wire's
 * `ai-run-*` / `ai-step-*` messages, carried on
 * {@link import('./transport.js').TransportEvent}.
 */

import type * as Ably from 'ably';

import type { RunEndReason, StepEndReason } from './shared.js';

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
   * invocation that drove it.
   * Empty string if the wire didn't carry an invocation-id.
   */
  invocationId: string;
  /**
   * Ably server timestamp (epoch ms) of the lifecycle message. A consumer
   * tracking run activity reads it as the run's last-activity time. Optional
   * because a step-lifecycle event the writer seeds locally has none; every
   * run-lifecycle event is wire-delivered and carries one.
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
      /** The run opened. */
      type: 'start';
      /**
       * Ably channel serial of the run-start message. A consumer ordering
       * sibling runs reads it as the run's start serial. Typed optional for
       * the union's sake; a run-lifecycle event is always wire-delivered, so
       * in practice it is present.
       */
      serial: string | undefined;
      /** The transport-message-id of the parent message, if known. Omitted for root runs. */
      parent?: string;
      /**
       * The transport-message-id of the user prompt being forked, when the run is an
       * edit. Carried verbatim from the `fork-of` wire header.
       */
      forkOf?: string;
      /**
       * The transport-message-id of the assistant message this run regenerates, when
       * the run is a regenerate continuation. Carried verbatim from the
       * `msg-regenerate` wire header. A regenerate is a continuation (no
       * `forkOf` at the run level); a consumer reconstructing conversation
       * structure realises the message replacement when materialising messages.
       */
      regenerates?: string;
      /**
       * The transport-message-id of the input event that triggered this run — the
       * `input-transport-message-id` wire header the agent stamps on run-start. It
       * is the handle the client owns at send time (before the agent mints the
       * `runId`): the client transport resolves `PublishInputResult.runId`
       * from it, and a consumer reconstructing conversation structure can
       * reconcile optimistic state keyed by this same transport-message-id onto
       * the agent-minted `runId`. Absent on a
       * fresh-send / regenerate run-start whose trigger backs no reply run.
       */
      inputTransportMessageId?: string;
    })
  | (RunLifecycleBase & {
      /** The run paused without ending; a resume may re-open it. */
      type: 'suspend';
      /**
       * Ably channel serial of the run-suspend message — the serial at which
       * the run paused. Present in practice; see the run-start note.
       */
      serial: string | undefined;
    })
  | (RunLifecycleBase & {
      /** A later invocation re-opened a suspended run. */
      type: 'resume';
      /**
       * Ably channel serial of the run-resume message. A resume re-enters an
       * existing run; the original run-start keeps the run's start serial.
       * Present in practice; see the run-start note.
       */
      serial: string | undefined;
    })
  | (RunLifecycleBase & {
      /** The run reached its terminal; nothing more publishes under it. */
      type: 'end';
      /**
       * Ably channel serial of the run-end message — the run's end serial.
       * Present in practice; see the run-start note.
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
             * when the run ended in error without detail).
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
 * Both arms carry the run-id and the step-id (stable across retry attempts). An
 * attempt's identity is the channel serial of its `step-start` (its
 * `step-start-serial`): a `step-start` carries that as its own `serial`, and a
 * `step-end` back-references it. The canonical attempt for a step-id is the one
 * whose `step-start` has the latest `serial`; a consumer materialising the
 * run's output includes only the canonical attempt's output, and excludes
 * every superseded attempt's.
 *
 * Both arms also carry the invocation correlation (`invocationId`) and the
 * three concentric client-identity scopes (`runClientId` ⊃ `invocationClientId`
 * ⊃ `stepClientId`), each an empty string when the wire didn't carry it, for
 * consumers correlating
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
       * Ably channel serial of the step-start message — the attempt's identity
       * (its `step-start-serial`) — or `undefined` for an optimistic local event.
       * Determines the canonical attempt: the latest serial for a given step-id
       * wins. An undefined serial sorts lowest (an optimistic seed), and the
       * concrete-serial echo promotes it.
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
      /**
       * The serial of the `step-start` this end closes (wire
       * `step-start-serial`) — the attempt's identity. Matches that
       * `step-start`'s own `serial`.
       */
      stepStartSerial: string;
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
