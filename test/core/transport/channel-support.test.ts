import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import {
  closedError,
  ContinuityWatcher,
  isContinuityLost,
  subscribeAndAttach,
  wrapMessageProcessingError,
} from '../../../src/core/transport/channel-support.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

const stateChange = (
  current: Ably.ChannelState,
  resumed: boolean,
  reason?: Ably.ErrorInfo,
): Ably.ChannelStateChange => ({ current, previous: 'initialized', resumed, reason });

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// eslint-disable-next-line @typescript-eslint/no-empty-function -- listener identity only
const noopListener = (): void => {};

describe('isContinuityLost', () => {
  it('is true for failed, suspended, and detached', () => {
    expect(isContinuityLost(stateChange('failed', true))).toBe(true);
    expect(isContinuityLost(stateChange('suspended', true))).toBe(true);
    expect(isContinuityLost(stateChange('detached', true))).toBe(true);
  });

  it('is true for an un-resumed re-attach but false for a resumed one', () => {
    expect(isContinuityLost(stateChange('attached', false))).toBe(true);
    expect(isContinuityLost(stateChange('attached', true))).toBe(false);
  });

  it('is false for benign states', () => {
    expect(isContinuityLost(stateChange('attaching', false))).toBe(false);
    expect(isContinuityLost(stateChange('initialized', false))).toBe(false);
  });
});

describe('subscribeAndAttach', () => {
  it('subscribes the listener, attaches the channel, and resolves on success', async () => {
    const subscribe = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());
    const attach = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());
    const channel = { subscribe, attach, unsubscribe: vi.fn() } as unknown as Ably.RealtimeChannel;
    const onError = vi.fn();

    await expect(
      subscribeAndAttach(channel, noopListener, silentLogger, 'Transport', onError),
    ).resolves.toBeUndefined();
    expect(subscribe).toHaveBeenCalledWith(noopListener);
    // attach() is forced after subscribe: subscribe's implicit attach can resolve
    // with the channel still INITIALIZED.
    expect(attach).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('wraps a subscribe failure, reports it via onError, and rejects with the same error', async () => {
    const cause = new Ably.ErrorInfo('attach refused', 40160, 401);
    const subscribe = vi.fn<() => Promise<void>>().mockRejectedValue(cause);
    const attach = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());
    const channel = { subscribe, attach, unsubscribe: vi.fn() } as unknown as Ably.RealtimeChannel;
    const onError = vi.fn();

    const rejection = subscribeAndAttach(channel, noopListener, silentLogger, 'Transport', onError);
    await expect(rejection).rejects.toBeErrorInfo({
      code: ErrorCode.SessionSubscriptionFailed,
      statusCode: 500,
      message: 'unable to subscribe and attach channel; attach refused',
      cause,
    });
    // The same error instance is both surfaced and thrown, never two deliveries.
    const surfaced = onError.mock.calls[0]?.[0] as Ably.ErrorInfo;
    await expect(rejection.catch((error: unknown) => error)).resolves.toBe(surfaced);
    // A subscribe failure short-circuits before the explicit attach.
    expect(attach).not.toHaveBeenCalled();
  });

  it('wraps an attach failure, reports it via onError, and rejects with the same error', async () => {
    const cause = new Ably.ErrorInfo('attach timed out', 90007, 500);
    const subscribe = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());
    const attach = vi.fn<() => Promise<void>>().mockRejectedValue(cause);
    const channel = { subscribe, attach, unsubscribe: vi.fn() } as unknown as Ably.RealtimeChannel;
    const onError = vi.fn();

    const rejection = subscribeAndAttach(channel, noopListener, silentLogger, 'Transport', onError);
    await expect(rejection).rejects.toBeErrorInfo({
      code: ErrorCode.SessionSubscriptionFailed,
      statusCode: 500,
      message: 'unable to subscribe and attach channel; attach timed out',
      cause,
    });
    const surfaced = onError.mock.calls[0]?.[0] as Ably.ErrorInfo;
    await expect(rejection.catch((error: unknown) => error)).resolves.toBe(surfaced);
  });

  it('unsubscribes the listener before subscribing so a retry does not double-register it', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());
    const attach = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());
    const channel = { subscribe, attach, unsubscribe } as unknown as Ably.RealtimeChannel;

    await subscribeAndAttach(channel, noopListener, silentLogger, 'Transport', vi.fn());

    expect(unsubscribe).toHaveBeenCalledWith(noopListener);
    // The unsubscribe runs before the (re-)subscribe. Default to 0 so an
    // uncalled mock fails the greater-than-0 check rather than throwing.
    const [unsubOrder = 0] = unsubscribe.mock.invocationCallOrder;
    const [subOrder = 0] = subscribe.mock.invocationCallOrder;
    expect(unsubOrder).toBeGreaterThan(0);
    expect(unsubOrder).toBeLessThan(subOrder);
  });
});

describe('wrapMessageProcessingError', () => {
  it('wraps a thrown value as a SessionMessageProcessingFailed preserving the cause', () => {
    const cause = new Ably.ErrorInfo('boom', 50000, 500);
    expect(wrapMessageProcessingError(cause)).toBeErrorInfo({
      code: ErrorCode.SessionMessageProcessingFailed,
      statusCode: 500,
      message: 'unable to process channel message; boom',
      cause: { code: 50000 },
    });
  });

  it('wraps a plain Error with no cause', () => {
    const wrapped = wrapMessageProcessingError(new Error('bad payload'));
    expect(wrapped).toBeErrorInfoWithCode(ErrorCode.SessionMessageProcessingFailed);
    expect(wrapped.message).toBe('unable to process channel message; bad payload');
    expect(wrapped.cause).toBeUndefined();
  });
});

describe('closedError', () => {
  it('builds a SessionClosed error naming the method', () => {
    expect(closedError('send')).toBeErrorInfo({
      code: ErrorCode.SessionClosed,
      statusCode: 400,
      message: 'unable to send; transport is closed',
    });
  });
});

/**
 * A channel double exposing only what the watcher touches: its state, and the
 * `on`/`off` pair it registers its listener through.
 * @param state - The channel's state at construction, seeding the watcher.
 * @returns The double, plus a `fire` that drives its registered listeners.
 */
const watchableChannel = (
  state: Ably.ChannelState = 'initialized',
): {
  channel: Ably.RealtimeChannel;
  fire: (change: Ably.ChannelStateChange) => void;
  listenerCount: () => number;
} => {
  const listeners: Ably.channelEventCallback[] = [];
  const channel = {
    state,
    on: (listener: Ably.channelEventCallback) => listeners.push(listener),
    off: (listener: Ably.channelEventCallback) => {
      const at = listeners.indexOf(listener);
      if (at !== -1) listeners.splice(at, 1);
    },
    // CAST: the watcher reads only `state` and calls `on`/`off`.
  } as unknown as Ably.RealtimeChannel;
  return {
    channel,
    fire: (change) => {
      for (const listener of listeners) listener(change);
    },
    listenerCount: () => listeners.length,
  };
};

describe('ContinuityWatcher', () => {
  it('registers its listener on construction', () => {
    const { channel, listenerCount } = watchableChannel();

    new ContinuityWatcher(channel, () => {
      throw new Error('not expected');
    });

    expect(listenerCount()).toBe(1);
  });

  it('ignores state changes before the first attach, then reports losses after it', () => {
    const { channel, fire } = watchableChannel();
    const losses: Ably.ChannelState[] = [];
    new ContinuityWatcher(channel, (change) => losses.push(change.current));

    // Coming up is not continuity being lost.
    fire(stateChange('detached', false));
    fire(stateChange('suspended', false));
    expect(losses).toEqual([]);

    fire(stateChange('attached', false));
    // The attach itself is the initial one, not a loss.
    expect(losses).toEqual([]);

    fire(stateChange('suspended', false));
    expect(losses).toEqual(['suspended']);
  });

  it('reports the first loss on a channel that was already attached', () => {
    // A caller-owned channel can already be ATTACHED, and attaching an
    // attached channel emits no state change, so the seed is the only thing
    // that lets the first loss through.
    const { channel, fire } = watchableChannel('attached');
    const losses: Ably.ChannelState[] = [];
    new ContinuityWatcher(channel, (change) => losses.push(change.current));

    fire(stateChange('failed', false));

    expect(losses).toEqual(['failed']);
  });

  it('does not report a benign state change', () => {
    const { channel, fire } = watchableChannel('attached');
    const losses: Ably.ChannelState[] = [];
    new ContinuityWatcher(channel, (change) => losses.push(change.current));

    fire(stateChange('attaching', false));
    fire(stateChange('attached', true));

    expect(losses).toEqual([]);
  });

  it('stops reporting once disposed, and removes its listener', () => {
    const { channel, fire, listenerCount } = watchableChannel('attached');
    const losses: Ably.ChannelState[] = [];
    const watcher = new ContinuityWatcher(channel, (change) => losses.push(change.current));

    watcher.dispose();
    fire(stateChange('failed', false));

    expect(losses).toEqual([]);
    expect(listenerCount()).toBe(0);
  });

  it('is idempotent on dispose', () => {
    const { channel, listenerCount } = watchableChannel('attached');
    const watcher = new ContinuityWatcher(channel, () => {
      throw new Error('not expected');
    });

    watcher.dispose();
    watcher.dispose();

    expect(listenerCount()).toBe(0);
  });
});
