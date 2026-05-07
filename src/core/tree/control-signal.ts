/**
 * The four SDK-defined control signals. Shape is fixed by the wire
 * protocol (`x-ably-abort`, `x-ably-pause`, `x-ably-resume`,
 * `x-ably-retry`) and does not depend on the codec.
 */
export type ControlSignalType = 'abort' | 'pause' | 'resume' | 'retry';

/**
 * A control signal observed on the channel. Codec-independent, owned by
 * the SDK. Recorded on the targeted run's {@link Run.controlSignals} list
 * and delivered via the tree's `'control-signal'` event.
 *
 * Observation does not mutate run or step status — the agent processes
 * the signal and emits the lifecycle event (`x-ably-run-end`,
 * `x-ably-step-start`) that actually transitions state.
 */
export interface ControlSignal {
  /** Which signal this is. */
  readonly type: ControlSignalType;

  /** The run the signal targets. Taken from `x-ably-run-id`. */
  readonly runId: string;

  /**
   * The step the signal targets, when present. Carried by `'retry'`
   * for step-level scoping; never present on `'abort'`, `'pause'`, or
   * `'resume'` (resume always picks up from the last observed step).
   */
  readonly stepId?: string;

  /**
   * The wire message id of the signal itself (`x-ably-msg-id`). Pair
   * this with an {@link Invocation}'s `messageId` precondition when
   * waking an agent in response to the signal — the SDK records the
   * id on the run so the precondition resolves once the signal is
   * visible.
   */
  readonly messageId: string;

  /**
   * Attribution clientId. Taken from the `x-ably-client-id` header
   * when the signal was published on behalf of an end-user
   * (server-side orchestration); otherwise taken from the publishing
   * connection's `message.clientId`.
   */
  readonly clientId: string;
}
