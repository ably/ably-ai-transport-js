import type { AnyCodec, CodecMessage } from '../codec/index.js';
import type { Invocation } from '../invocation/index.js';
import { Invocation as InvocationCtor } from '../invocation/index.js';
import type { Run, RunStatus } from './run.js';

/**
 * Run as seen from a {@link ClientSession}. Phase 6 subset of the RFC's
 * `ClientRun<C>` — adds {@link toInvocation} on top of the base
 * {@link Run<TMessage>}. Lifecycle and control methods (`start`, `abort`,
 * `pause`, `resume`, `retry`, `sendMessages`, `sendParts`, `sendEvents`)
 * land in later phases.
 *
 * Returned by {@link ClientView.send}; the caller serialises
 * `run.toInvocation().toJSON()` and POSTs it to an agent endpoint to wake
 * the workflow.
 */
export interface ClientRun<C extends AnyCodec> extends Run<CodecMessage<C>> {
  /**
   * Snapshot the run's current state into an {@link Invocation} the caller
   * can serialise and POST to an agent endpoint. Carries the session name,
   * this run's ID, and (when present) the message ID of the message that
   * opened the run, so the agent can wait for that message to be visible
   * before starting its step.
   * @returns A new {@link Invocation} bound to this run's preconditions.
   */
  toInvocation(): Invocation;
}

/** Options for {@link createClientRun}. */
export interface ClientRunOptions {
  /** The run's unique ID. */
  id: string;
  /** Initial run status — phase 6 always opens runs as `'active'`. */
  status: RunStatus;
  /** The clientId of the participant that opened the run. */
  initiatorClientId: string;
  /** The session this run belongs to; written into produced invocations. */
  sessionName: string;
  /**
   * The message ID published alongside `x-ably-run-start`. When present, an
   * agent receiving the produced {@link Invocation} can wait for this
   * message to be visible on the channel before starting its step.
   */
  messageId?: string;
}

/**
 * Build a {@link ClientRun} value object. The returned object is immutable
 * — phase 6 produces it once, on a successful {@link ClientView.send}, and
 * never mutates it afterwards. Run state changes are observed via the tree
 * (and, in later phases, via run-handle methods that re-read the tree).
 * @param options The run's identity and session binding.
 * @returns A {@link ClientRun} carrying the supplied state.
 */
export const createClientRun = <C extends AnyCodec>(options: ClientRunOptions): ClientRun<C> => {
  const { id, status, initiatorClientId, sessionName, messageId } = options;
  return {
    id,
    status,
    initiatorClientId,
    toInvocation: (): Invocation =>
      InvocationCtor.fromJSON({
        sessionName,
        runId: id,
        ...(messageId === undefined ? {} : { messageId }),
      }),
  };
};
