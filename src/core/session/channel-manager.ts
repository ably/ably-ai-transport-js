import * as Ably from 'ably';

import type { Logger } from '../../logger.js';

/**
 * Manages a single Ably realtime channel for a session, lazily resolved on
 * first access. A session today is backed by a single channel whose name
 * matches the session name; the manager exists so the rest of the session
 * doesn't need to know how the channel is fetched or released and so we can
 * evolve toward multiple channels per session without churning callers.
 */
export class ChannelManager {
  private readonly _realtime: Ably.Realtime;
  private readonly _logger: Logger;
  private readonly _channelName: string;
  private _resolvedChannel?: Ably.RealtimeChannel;

  /**
   * @param realtime The Ably Realtime client owning the channel.
   * @param channelName The channel name to manage (the session name).
   * @param logger Logger used for trace output.
   */
  constructor(realtime: Ably.Realtime, channelName: string, logger: Logger) {
    this._realtime = realtime;
    this._channelName = channelName;
    this._logger = logger.withContext({ component: 'ChannelManager', channelName });
  }

  /**
   * Resolve and return the channel. The first call lazily fetches it from the
   * realtime client; subsequent calls return the same channel instance.
   * @returns The realtime channel.
   */
  get(): Ably.RealtimeChannel {
    this._logger.trace('ChannelManager.get();');
    this._resolvedChannel ??= this._realtime.channels.get(this._channelName);
    return this._resolvedChannel;
  }

  /**
   * Whether the channel has been acquired via {@link get} and not yet
   * released. Callers use this to decide whether teardown work is required
   * — if the channel was never acquired, there is nothing to detach or
   * release.
   * @returns `true` once {@link get} has been called and before {@link release}.
   */
  get isResolved(): boolean {
    return this._resolvedChannel !== undefined;
  }

  /**
   * Release the channel from the realtime client. No-op if the channel was
   * never resolved.
   *
   * Callers are responsible for removing any listeners they registered on
   * the channel — the manager does not track them.
   */
  release(): void {
    this._logger.trace('ChannelManager.release();');
    if (!this._resolvedChannel) {
      return;
    }
    this._realtime.channels.release(this._channelName);
    this._resolvedChannel = undefined;
  }
}
