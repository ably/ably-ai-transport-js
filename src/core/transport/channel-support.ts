/**
 * Channel lifecycle plumbing the transport is built from: the subscribe-then-
 * attach step, the closed-state error, and the continuity watcher that turns a
 * channel state change into a discontinuity report.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';

/**
 * Subscribe a listener to a channel and attach it.
 *
 * `subscribe()` is followed by an explicit `attach()`: `subscribe()` initiates
 * the implicit attach-on-subscribe (RTL7g, subscribe before attach), but its
 * promise does not reliably resolve only once the channel reaches ATTACHED
 * (when the implicit attach is interrupted by a rapid mount/unmount/remount
 * cycle it can resolve with the channel still INITIALIZED). `attach()` is
 * idempotent, a no-op when already attaching or attached, so it makes the
 * guarantee hold.
 *
 * Retry-safe: `subscribe()` registers the listener synchronously, before the
 * implicit attach it triggers can fail, so a failed attempt leaves the listener
 * registered. This unsubscribes the listener first (a no-op on the first
 * attempt) so a retry registers it exactly once.
 * @param channel - The transport's channel.
 * @param listener - The message listener to subscribe (also the unsubscribe handle on close).
 * @param logger - Logger for the success and failure lines.
 * @param component - The owning component's name, used as the log message prefix.
 * @param onError - Called with the wrapped error before it is thrown, so the owner can put it on its error stream.
 * @returns A promise that resolves once subscribed and attached.
 * @throws {Ably.ErrorInfo} `SessionSubscriptionFailed` wrapping the subscribe or attach failure.
 */
export const subscribeAndAttach = async (
  channel: Ably.RealtimeChannel,
  listener: (message: Ably.InboundMessage) => void,
  logger: Logger | undefined,
  component: string,
  onError: (error: Ably.ErrorInfo) => void,
): Promise<void> => {
  try {
    channel.unsubscribe(listener);
    await channel.subscribe(listener);
    await channel.attach();
    logger?.debug(`${component}.subscribe(); subscribed and attached`);
  } catch (error) {
    const errInfo = new Ably.ErrorInfo(
      `unable to subscribe and attach channel; ${errorMessage(error)}`,
      ErrorCode.SessionSubscriptionFailed,
      500,
      errorCause(error),
    );
    logger?.error(`${component}.subscribe(); subscribe or attach failed`, {
      channel: channel.name,
      error: errorMessage(error),
    });
    onError(errInfo);
    throw errInfo;
  }
};

/**
 * Wrap a failure thrown while processing an inbound channel message as a
 * `SessionMessageProcessingFailed`, preserving the original as `cause`. Kept
 * distinct from `SessionSubscriptionFailed`: the subscription survives this,
 * so the transport stays usable and the fix is in the codec or the handler.
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
 * Build the error every call on a closed transport throws.
 * @param method - The method name, named in the error message.
 * @returns The error.
 */
export const closedError = (method: string): Ably.ErrorInfo =>
  new Ably.ErrorInfo(`unable to ${method}; transport is closed`, ErrorCode.SessionClosed, 400);

/**
 * Whether a channel state change breaks message continuity: FAILED, SUSPENDED
 * or DETACHED, where no more messages are expected, or ATTACHED with
 * `resumed: false`, where messages were lost. The initial attach is the
 * watcher's concern and is not handled here.
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
 * Watch a channel for continuity loss and report each one to the owner.
 *
 * Registers its listener on construction so a retried attach cannot report a
 * loss once per attempt, seeds from an already-attached channel because
 * attaching an attached channel emits no state change, and ignores state
 * changes before the first attach, which are the channel coming up.
 */
export class ContinuityWatcher {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _onLoss: (stateChange: Ably.ChannelStateChange) => void;
  /** One bound reference, so `dispose()` removes the same listener it registered. */
  private readonly _listener: Ably.channelEventCallback;
  private _hasAttachedOnce: boolean;
  private _disposed = false;

  /**
   * @param channel - The transport's channel.
   * @param onLoss - Called with each continuity-breaking state change after the first attach. Never called once disposed.
   */
  constructor(channel: Ably.RealtimeChannel, onLoss: (stateChange: Ably.ChannelStateChange) => void) {
    this._channel = channel;
    this._onLoss = onLoss;
    this._hasAttachedOnce = channel.state === 'attached';
    this._listener = (stateChange: Ably.ChannelStateChange) => {
      this._handle(stateChange);
    };
    channel.on(this._listener);
  }

  /** Remove the listener and stop reporting. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._channel.off(this._listener);
  }

  private _handle(stateChange: Ably.ChannelStateChange): void {
    if (this._disposed) return;
    if (!this._hasAttachedOnce) {
      if (stateChange.current === 'attached') this._hasAttachedOnce = true;
      return;
    }
    if (!isContinuityLost(stateChange)) return;
    this._onLoss(stateChange);
  }
}
