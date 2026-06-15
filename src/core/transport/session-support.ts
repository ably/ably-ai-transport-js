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

/**
 * Resolve a session's connect guard: return the in-flight/settled connect
 * promise, or reject with `InvalidArgument` when `connect()` has not been
 * called. Callers `await` the result before any write.
 * @param connectPromise - The session's connect promise, or `undefined` when not yet connected.
 * @param method - The method name being guarded, for the error message.
 * @returns The connect promise.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when `connectPromise` is `undefined`.
 */
export const requireConnected = async (connectPromise: Promise<void> | undefined, method: string): Promise<void> => {
  if (!connectPromise) {
    throw new Ably.ErrorInfo(
      `unable to ${method}; connect() must be called before ${method}()`,
      ErrorCode.InvalidArgument,
      400,
    );
  }
  return connectPromise;
};

/**
 * Detach the session's channel on close, best-effort. `connect()` subscribes
 * (which implicitly attaches), so a detach is only attempted when `connect()`
 * ran. A detach failure (e.g. the channel is already FAILED) must not throw out
 * of `close()`, so it is swallowed and logged at debug.
 * @param channel - The session's channel.
 * @param connectPromise - The session's connect promise; detach is skipped when `undefined`.
 * @param logger - Logger for the swallowed-failure debug line, or `undefined`.
 * @param component - The owning class name, used as the log message prefix.
 */
export const bestEffortDetach = async (
  channel: Ably.RealtimeChannel,
  connectPromise: Promise<void> | undefined,
  logger: Logger | undefined,
  component: string,
): Promise<void> => {
  if (connectPromise === undefined) return;
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
