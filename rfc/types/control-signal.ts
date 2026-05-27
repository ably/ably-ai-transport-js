/**
 * The four SDK-defined control signals. Shape is fixed by the wire protocol
 * (`x-ably-abort`, `x-ably-pause`, `x-ably-resume`, `x-ably-retry`) and does
 * not depend on the codec.
 */
export type ControlSignalType = 'abort' | 'pause' | 'resume' | 'retry';

/**
 * A control signal observed on the channel. SDK-owned and codec-independent —
 * every signal carries the target run ID and, where the protocol defines it,
 * a target step ID. Produced by initiators (client, backend, parent agent) to
 * influence a running run; observed by live agents on subscription and by any
 * participant during hydration.
 *
 * Delivered via {@link Tree}'s `'control-signal'` event. Observers receive a
 * `ControlSignal` together with the targeted run. The step-scoped ergonomic
 * shortcut on {@link Step.on} `'pause'` still fires for `type: 'pause'`.
 */
export interface ControlSignal {
  /** Which signal this is. */
  readonly type: ControlSignalType;

  /** The run the signal targets. Taken from `x-ably-run-id`. */
  readonly runId: string;

  /**
   * The step the signal targets, when present. Only meaningful on `'resume'`
   * and `'retry'`; `'abort'` and `'pause'` never carry a step ID.
   */
  readonly stepId?: string;

  /**
   * The channel message ID of the signal itself. Callers pair this with an
   * {@link Invocation}'s `messageId` precondition when waking an agent in
   * response to the signal.
   */
  readonly messageId: string;

  /**
   * Attribution clientId. Taken from the `x-ably-client-id` header when the
   * signal was published on behalf of an end-user (server-side orchestration),
   * otherwise from the publishing connection's `message.clientId`.
   */
  readonly clientId: string;
}
