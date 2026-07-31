/**
 * Shared lifecycle plumbing for the client and agent sessions.
 *
 * Both `DefaultClientSession` and `DefaultAgentSession` gate their writes on
 * `connect()` having run, detach their channel best-effort on close, and react
 * to channel continuity loss with the same detection rule and error shape.
 * These helpers own that common machinery so the two sessions cannot drift on
 * the connection guard, the detach-swallow behaviour, or — most importantly —
 * the continuity-loss predicate, which encodes channel protocol semantics
 * (Spec AIT-CT19 / AIT-ST12). Each session keeps its own divergent reaction to
 * continuity loss (the client emits; the agent aborts runs and swaps its Tree).
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';

/**
 * Lifecycle state shared by both sessions: a session is `READY` from
 * construction until `close()` flips it to `CLOSED`. There is no separate
 * "connected" state — connection is tracked by the presence of a connect
 * promise, not this enum.
 */
export enum SessionState {
  /** The session is open; writes and message processing proceed. */
  READY = 'ready',
  /** `close()` has run; further operations are rejected or ignored. */
  CLOSED = 'closed',
}

/**
 * The unsubscribe function both sessions' `on('error', …)` return when the
 * session is already CLOSED — a no-op, since no further events will fire so
 * the handler is never registered. Shared so the two sessions don't each
 * carry their own copy.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op
export const noopUnsubscribe = (): void => {};

/**
 * Subscribe a session's listener to its channel and attach the channel. Both
 * sessions cache the returned promise as their connect guard, so this is the
 * single place the subscribe-and-attach step — and its failure shape — is
 * defined.
 *
 * `subscribe()` is followed by an explicit `attach()`: `subscribe()` initiates
 * the implicit attach-on-subscribe (RTL7g — subscribe before attach), but its
 * promise does not reliably resolve only once the channel reaches ATTACHED
 * (e.g. when the implicit attach is interrupted by a rapid mount/unmount/remount
 * cycle, it can resolve with the channel still INITIALIZED). The session's write
 * guard requires the channel to be ATTACHED/ATTACHING by the time `connect()`
 * resolves, so `attach()` (idempotent — a no-op when already attaching/attached)
 * makes that guarantee hold. On success logs at debug; on failure builds a
 * `SessionSubscriptionError`, logs at error, hands it to `onError`, and rejects
 * with it.
 *
 * Retry-safe: `subscribe()` registers the listener synchronously, before the
 * implicit attach it triggers can fail, so a failed attempt leaves the listener
 * registered. This unsubscribes the listener first (a no-op on the first
 * attempt) so a `connect()` retry after a failure registers it exactly once
 * rather than accumulating duplicate deliveries.
 * @param channel - The session's channel.
 * @param listener - The message listener to subscribe (also the unsubscribe handle on close).
 * @param logger - Logger for the success/failure lines, or `undefined`.
 * @param component - The owning class name, used as the log message prefix.
 * @param onError - Called with the subscription error before it is thrown
 *   (both sessions emit it on their session `on('error')`).
 * @returns A promise that resolves once subscribed and attached, or rejects with
 *   the `SessionSubscriptionError`.
 */
export const subscribeAndAttach = async (
  channel: Ably.RealtimeChannel,
  listener: (message: Ably.InboundMessage) => void,
  logger: Logger | undefined,
  component: string,
  onError: (error: Ably.ErrorInfo) => void,
): Promise<void> => {
  try {
    // Drop any registration a prior failed attempt left behind before
    // re-subscribing, so retries don't double-register the listener.
    channel.unsubscribe(listener);
    await channel.subscribe(listener);
    // Force the attach: subscribe's implicit attach can resolve with the channel
    // still INITIALIZED, but the write guard needs it ATTACHED/ATTACHING. attach()
    // is idempotent, so this is a no-op once the implicit attach has completed.
    await channel.attach();
    logger?.debug(`${component}.connect(); subscribed and attached`);
  } catch (error) {
    // One bracket covers both steps; name both so an attach failure isn't
    // mislabelled as a subscribe failure.
    const errInfo = new Ably.ErrorInfo(
      `unable to subscribe and attach channel; ${errorMessage(error)}`,
      ErrorCode.SessionSubscriptionError,
      500,
      errorCause(error),
    );
    logger?.error(`${component}.connect(); subscribe or attach failed`);
    onError(errInfo);
    throw errInfo;
  }
};

/**
 * Wrap a failure thrown while processing an inbound channel message as a
 * `SessionMessageProcessingFailed`, preserving the original as `cause`. Single source
 * of truth for the message-processing error shape both sessions surface. Kept
 * distinct from the connect-time `SessionSubscriptionError`: the subscription
 * survives this, so the session stays usable and the fix is in the handler.
 * @param error - The thrown value.
 * @returns The wrapped error.
 */
export const wrapMessageProcessingError = (error: unknown): Ably.ErrorInfo =>
  new Ably.ErrorInfo(
    `unable to process channel message; ${errorMessage(error)}`,
    ErrorCode.SessionMessageProcessingFailed,
    500,
    errorCause(error),
  );

/**
 * Run a session's per-message processing inside the shared error bracket: a
 * throw is wrapped via {@link wrapMessageProcessingError} and handed to
 * `onError` so one bad message can't kill the subscription. Both sessions route
 * their channel-message handler through this so the bracket and the surfaced
 * error are identical.
 * @param process - The message-processing body (fold, dispatch, side-effects).
 * @param onError - Called with the wrapped error when `process` throws.
 */
export const handleWireMessage = (process: () => void, onError: (error: Ably.ErrorInfo) => void): void => {
  try {
    process();
  } catch (error) {
    onError(wrapMessageProcessingError(error));
  }
};

/**
 * Single-flight connection guard shared by both sessions. Owns the connect
 * promise and the last connect failure so the client and agent sessions cannot
 * drift on the retry-after-failure semantics or the write-guard error shapes.
 *
 * A successful or in-flight connect is cached and returned to every caller, so
 * `connect()` is idempotent. A FAILED connect is deliberately NOT cached: the
 * promise is cleared so a subsequent `connect()` retries the subscribe/attach
 * against a channel that may since have recovered. The failure is retained so a
 * write awaited through {@link ConnectGuard.requireConnected} surfaces the real
 * cause rather than a stale rejection, and tells the caller to reconnect.
 */
export class ConnectGuard {
  /** The in-flight or successfully-settled connect promise; cleared on failure. */
  private _promise: Promise<void> | undefined;
  /** The most recent connect failure, retained after the promise is cleared. */
  private _lastError: Ably.ErrorInfo | undefined;
  /** Whether `connect()` has ever started an attempt (stays true after a failure). */
  private _attempted = false;

  /**
   * Whether `connect()` has ever been called. Stays true after a failed attempt
   * (which clears the connect promise), so `close()` can gate the
   * unsubscribe/detach that the attempt's `subscribe()` set up even when the
   * attach that followed it failed.
   * @returns True once a connect attempt has started.
   */
  get attempted(): boolean {
    return this._attempted;
  }

  /**
   * Return the in-flight/successful connect promise, or start a fresh attempt
   * via `attempt`. Single-flight: concurrent and repeat calls share one attempt.
   * A rejected attempt is not cached (the next call retries) but its rejection
   * still propagates, so the caller of `connect()` observes the failure.
   * @param attempt - Runs the subscribe/attach; invoked only when no attempt is held.
   * @returns The shared connect promise.
   */
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- return the cached promise by reference, not a fresh wrapper
  connect(attempt: () => Promise<void>): Promise<void> {
    if (this._promise) return this._promise;
    this._attempted = true;
    this._promise = this._attempt(attempt);
    return this._promise;
  }

  private async _attempt(attempt: () => Promise<void>): Promise<void> {
    try {
      await attempt();
      this._lastError = undefined;
    } catch (error) {
      // Do not cache the rejection: clear the promise so a later connect()
      // retries, and keep the cause so requireConnected() can surface it.
      this._promise = undefined;
      this._lastError =
        errorCause(error) ?? new Ably.ErrorInfo(errorMessage(error), ErrorCode.SessionSubscriptionError, 500);
      throw error;
    }
  }

  /**
   * The write guard: `await` this before any write. Resolves once connected.
   * Rejects with `InvalidArgument` when `connect()` has never been called; when a
   * prior `connect()` failed, rejects with the real failure (as `cause`) wrapped
   * in guidance to call `connect()` again.
   * @param method - The method name being guarded, for the error message.
   * @returns A promise that resolves once connected.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when never connected, or the
   *   wrapped connect failure when a prior attempt failed.
   */
  async requireConnected(method: string): Promise<void> {
    const promise = this._promise;
    if (promise) {
      try {
        await promise;
        return;
      } catch {
        // The attempt rejected; _attempt() recorded _lastError before this
        // propagated, so fall through to surface the wrapped guidance.
      }
    }
    if (this._lastError) {
      throw new Ably.ErrorInfo(
        `unable to ${method}; connect() failed, call connect() again to retry; ${this._lastError.message}`,
        this._lastError.code,
        this._lastError.statusCode,
        this._lastError,
      );
    }
    throw new Ably.ErrorInfo(
      `unable to ${method}; connect() must be called before ${method}()`,
      ErrorCode.InvalidArgument,
      400,
    );
  }
}

/**
 * Detach the session's channel on close, best-effort. `connect()` subscribes
 * (which implicitly attaches), so a detach is only attempted when `connect()`
 * ran — including a failed attempt, whose `subscribe()` may have registered the
 * listener before the attach that followed it failed. A detach failure (e.g. the
 * channel is already FAILED) must not throw out of `close()`, so it is swallowed
 * and logged at debug.
 * @param channel - The session's channel.
 * @param attempted - Whether `connect()` ran; detach is skipped when `false`.
 * @param logger - Logger for the swallowed-failure debug line, or `undefined`.
 * @param component - The owning class name, used as the log message prefix.
 */
export const bestEffortDetach = async (
  channel: Ably.RealtimeChannel,
  attempted: boolean,
  logger: Logger | undefined,
  component: string,
): Promise<void> => {
  if (!attempted) return;
  try {
    await channel.detach();
  } catch (error) {
    logger?.debug(`${component}.close(); channel detach failed`, { error });
  }
};

/**
 * Whether a channel state change breaks message continuity:
 * - FAILED, SUSPENDED, DETACHED — no more messages expected (or a gap)
 * - ATTACHED with `resumed: false` (an UPDATE) — messages were lost
 *
 * The initial attach (ATTACHED with no prior attach) is the caller's concern
 * and is not handled here.
 * @param stateChange - The channel state change to classify.
 * @returns True when continuity was lost.
 */
export const isContinuityLost = (stateChange: Ably.ChannelStateChange): boolean => {
  const { current, resumed } = stateChange;
  return (
    current === 'failed' || current === 'suspended' || current === 'detached' || (current === 'attached' && !resumed)
  );
};

/**
 * Build the `ChannelContinuityLost` error for a continuity-breaking state
 * change, attaching the state change's `reason` as `cause`.
 * @param stateChange - The continuity-breaking state change.
 * @param verb - The operation that can no longer proceed, for the
 *   `unable to <verb>; ...` message (e.g. "deliver events", "continue").
 * @returns The continuity-loss error.
 */
export const continuityLostError = (stateChange: Ably.ChannelStateChange, verb: string): Ably.ErrorInfo => {
  const { current } = stateChange;
  return new Ably.ErrorInfo(
    `unable to ${verb}; channel continuity lost (${current}${current === 'attached' ? ', resumed: false' : ''})`,
    ErrorCode.ChannelContinuityLost,
    500,
    stateChange.reason,
  );
};
