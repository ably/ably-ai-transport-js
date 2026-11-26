/**
 * One read of a thread's AG-UI channel: the live messages of one run.
 *
 * A read subscribes a listener of its own, attaches the channel if nothing
 * has, and decodes what the channel delivers through a decoder of its own.
 * The read's owner releases it when the run ends. Releasing unsubscribes the
 * read and leaves the channel attached: the application owns the channel, and
 * detaches it when it is done with the thread.
 */

import * as Ably from '@ably/pubsub-core';
import type * as AGUI from '@ag-ui/client';

import type { Delivery } from '../../core/codec/index.js';
import type { Decoder } from '../../core/decoder/index.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { wrapReadError } from '../../utils.js';
import { agUiDecoder } from '../decoder.js';

/** Options for {@link ChannelRead}. */
export interface ChannelReadOptions {
  /** The thread's channel. */
  channel: Ably.RealtimeChannel;
  /** The agent's logger. */
  logger: Logger;
  /** Called once the channel is attached. */
  onAttached: () => void;
  /**
   * Called with each event that arrives, in channel order.
   * @param event - The event.
   */
  onEvent: (event: AGUI.Event) => void;
  /**
   * Called when a message that arrives cannot be decoded.
   * @param error - The decoder's error.
   */
  onUndecodable: (error: Ably.ErrorInfo) => void;
  /**
   * Called once when the read cannot go on: with an error when the channel
   * could not be read or lost continuity, and without one when the channel
   * became DETACHED, as it does when the page closes its Ably client.
   * @param error - The failure, if any.
   */
  onEnd: (error?: Ably.ErrorInfo) => void;
}

/**
 * Wait for the channel's next state change, such as the end of a detach in
 * flight.
 * @param channel - The channel.
 * @returns Resolves once the channel's state has changed.
 */
const nextStateChange = async (channel: Ably.RealtimeChannel): Promise<void> => {
  await new Promise<void>((resolve) => {
    const changed = (): void => {
      channel.off(changed);
      resolve();
    };
    channel.on(changed);
  });
};

/**
 * The AG-UI events a message decoded to: a message with no event, such as
 * one no codec wrote, is left out.
 * @param deliveries - The message's deliveries.
 * @returns The events.
 */
const eventsOf = (deliveries: Delivery<AGUI.Event>[]): AGUI.Event[] =>
  deliveries.flatMap(({ event }) => (event === undefined ? [] : [event]));

/**
 * The error a read ends with when the channel lost continuity once it was
 * attached for the read: FAILED or SUSPENDED, where no more messages arrive,
 * or ATTACHED with `resumed: false`, an UPDATE included, where some were lost.
 * @param stateChange - The state change.
 * @returns The error, or `undefined` when continuity holds.
 */
const continuityLost = (stateChange: Ably.ChannelStateChange): Ably.ErrorInfo | undefined => {
  const { current, resumed, reason } = stateChange;
  let how: string;
  if (current === 'failed' || current === 'suspended') how = `the channel became ${current}`;
  else if (current === 'attached' && !resumed) how = 'the channel attached again without resuming';
  else return undefined;
  return new Ably.ErrorInfo(
    `unable to read the channel; ${how}, so the run may be missing events`,
    ErrorCode.SessionContinuityNotGuaranteed,
    500,
    reason,
  );
};

/** One read of a thread's channel, from its creation until it ends or is released. */
export class ChannelRead {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _logger: Logger;
  private readonly _options: ChannelReadOptions;
  private readonly _decoder: Decoder<AGUI.Event>;
  private _released = false;
  private _ended = false;
  /** Whether the channel has reached ATTACHED since the read began watching it. */
  private _attachedSinceWatching = false;

  /**
   * Start reading.
   * @param options - See {@link ChannelReadOptions}.
   */
  constructor(options: ChannelReadOptions) {
    this._options = options;
    this._channel = options.channel;
    this._logger = options.logger.withContext({ component: 'ChannelRead', channel: options.channel.name });
    // A decoder of its own, so it has decoded nothing before this read, and
    // decodes every message it reads whole.
    this._decoder = agUiDecoder({ logger: this._logger });
    this._decoder.onError((error) => {
      if (!this._released && !this._ended) this._options.onUndecodable(error);
    });
    // Not awaited: `_start` reports its own failure through `onEnd`.
    void this._start();
  }

  /**
   * Stop reading: unsubscribe, and stop watching the channel. The channel
   * stays attached. Idempotent.
   */
  release(): void {
    if (this._released) return;
    this._released = true;
    this._logger.trace('ChannelRead.release();');
    this._channel.off(this._onStateChange);
    this._channel.unsubscribe(this._listener);
  }

  /**
   * Wait for a detach in flight to finish, then watch the channel, subscribe
   * and attach it. The watch on the channel's continuity starts only now: a
   * detach that finished before the read began must not count as this read
   * losing continuity.
   */
  private async _start(): Promise<void> {
    // A function rather than a plain field check: after the first check
    // TypeScript assumes the field stays false, though `release()` can set
    // it during the awaits below.
    const isReleased = (): boolean => this._released;
    const channel = this._channel;
    // ably-js takes the DETACHED that answers a detach as an attach in flight
    // failing, and suspends the channel. So a detach in flight, such as the
    // application letting the channel go, must finish first.
    if (channel.state === 'detaching') {
      this._logger.debug('ChannelRead._start(); waiting for a detach in flight');
      await nextStateChange(channel);
      if (isReleased()) return;
    }
    this._attachedSinceWatching = channel.state === 'attached';
    channel.on(this._onStateChange);
    try {
      // ably-js refuses to subscribe on a FAILED channel until something
      // attaches it again, so a read on one ends with that refusal.
      await channel.subscribe(this._listener);
      // A release during the subscribe has already unsubscribed the read, so
      // attaching the channel now would attach it for nothing.
      if (isReleased()) return;
      // Subscribing attaches the channel unless the application turned that
      // off, as `<ChannelProvider>` does.
      await channel.attach();
      if (isReleased()) return;
      this._logger.debug('ChannelRead._start(); attached');
      this._options.onAttached();
    } catch (error) {
      if (isReleased()) return;
      const failure = wrapReadError(error);
      this._logger.error('ChannelRead._start(); unable to read the channel', { error: failure.message });
      this._end(failure);
    }
  }

  /**
   * Decode each message the channel delivers, and hand on its events. Bound
   * once, so `release()` unsubscribes the same listener.
   * @param message - The message.
   */
  private readonly _listener = (message: Ably.InboundMessage): void => {
    if (this._isOver()) return;
    for (const event of eventsOf(this._decoder.decode(message))) {
      // A handler can end the read, as the run's end does.
      if (this._isOver()) return;
      this._options.onEvent(event);
    }
  };

  /**
   * Whether the read has ended or been released. A method rather than a
   * plain field check: after a first check TypeScript assumes the fields stay
   * false, though a handler can end the read in between.
   * @returns True once the read is over.
   */
  private _isOver(): boolean {
    return this._released || this._ended;
  }

  /**
   * End the read once the channel loses continuity after it attached, or
   * becomes DETACHED. State changes before the first ATTACHED are the channel
   * coming up. Bound once, so `release()` removes the same listener.
   * @param stateChange - The channel's state change.
   */
  private readonly _onStateChange = (stateChange: Ably.ChannelStateChange): void => {
    if (this._released || this._ended) return;
    if (!this._attachedSinceWatching) {
      if (stateChange.current === 'attached') this._attachedSinceWatching = true;
      return;
    }
    if (stateChange.current === 'detached') {
      this._logger.info('ChannelRead._onStateChange(); the channel became detached, so the read ends');
      this._end();
      return;
    }
    const lost = continuityLost(stateChange);
    if (lost === undefined) return;
    this._logger.error('ChannelRead._onStateChange(); the channel lost continuity', {
      current: stateChange.current,
      resumed: stateChange.resumed,
    });
    this._end(lost);
  };

  /**
   * End the read, once.
   * @param error - The failure, if any.
   */
  private _end(error?: Ably.ErrorInfo): void {
    if (this._ended) return;
    this._ended = true;
    this._options.onEnd(error);
  }
}
