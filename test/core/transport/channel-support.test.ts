import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import {
  ConnectGuard,
  continuityLostError,
  isContinuityLost,
  reportPage,
  subscribeAndAttach,
  wrapMessageProcessingError,
} from '../../../src/core/transport/channel-support.js';
import { ErrorCode } from '../../../src/errors.js';
import { type LogHandler, LogLevel, makeLogger } from '../../../src/logger.js';

const stateChange = (
  current: Ably.ChannelState,
  resumed: boolean,
  reason?: Ably.ErrorInfo,
): Ably.ChannelStateChange => ({ current, previous: 'initialized', resumed, reason });

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// eslint-disable-next-line @typescript-eslint/no-empty-function -- listener identity only
const noopListener = (): void => {};

const subscribeError = (): Ably.ErrorInfo => new Ably.ErrorInfo('attach timed out', ErrorCode.SubscriptionFailed, 500);

describe('ConnectGuard', () => {
  it('reports not attempted until connect() is called', () => {
    const guard = new ConnectGuard();
    expect(guard.attempted).toBe(false);
  });

  it('runs the attempt once and shares the promise across concurrent connect() calls', async () => {
    const guard = new ConnectGuard();
    const attempt = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());

    const first = guard.connect(attempt);
    const second = guard.connect(attempt);

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(attempt).toHaveBeenCalledOnce();
    expect(guard.attempted).toBe(true);
  });

  it('resolves requireConnected() once connected', async () => {
    const guard = new ConnectGuard();
    await guard.connect(vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve()));
    await expect(guard.requireConnected('send')).resolves.toBeUndefined();
  });

  it('rejects requireConnected() with InvalidArgument when connect() was never called', async () => {
    const guard = new ConnectGuard();
    await expect(guard.requireConnected('send')).rejects.toBeErrorInfo({
      code: ErrorCode.InvalidArgument,
      statusCode: 400,
      message: 'unable to send; connect() must be called before send()',
    });
  });

  it('does not cache a failed attempt: a later connect() retries and can succeed', async () => {
    const guard = new ConnectGuard();
    const attempt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(subscribeError())
      .mockReturnValueOnce(Promise.resolve());

    await expect(guard.connect(attempt)).rejects.toBeErrorInfoWithCode(ErrorCode.SubscriptionFailed);
    // Stays attempted after a failure, so close() still tears down the
    // subscription the failed attempt's subscribe() may have registered.
    expect(guard.attempted).toBe(true);

    // The next connect() retries against a (recovered) channel.
    await expect(guard.connect(attempt)).resolves.toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(2);
    await expect(guard.requireConnected('send')).resolves.toBeUndefined();
  });

  it('surfaces the real failure wrapped in reconnect guidance from requireConnected() after a failed connect', async () => {
    const guard = new ConnectGuard();
    const cause = subscribeError();
    await expect(guard.connect(vi.fn<() => Promise<void>>().mockRejectedValue(cause))).rejects.toBe(cause);
    await expect(guard.requireConnected('send')).rejects.toBeErrorInfo({
      code: ErrorCode.SubscriptionFailed,
      statusCode: 500,
      message: 'unable to send; connect() failed, call connect() again to retry; attach timed out',
      cause,
    });
  });

  it('surfaces the wrapped guidance to a write racing an in-flight connect that then fails', async () => {
    const guard = new ConnectGuard();
    const cause = subscribeError();
    const { promise: attemptPromise, reject: rejectAttempt } = Promise.withResolvers<undefined>();

    const connectPromise = guard.connect(vi.fn<() => Promise<void>>().mockReturnValue(attemptPromise));
    // A write started while the connect is still in flight.
    const guarded = guard.requireConnected('send');
    rejectAttempt(cause);

    await expect(connectPromise).rejects.toBe(cause);
    await expect(guarded).rejects.toBeErrorInfo({
      code: ErrorCode.SubscriptionFailed,
      statusCode: 500,
      message: 'unable to send; connect() failed, call connect() again to retry; attach timed out',
      cause,
    });
  });

  it('wraps a non-ErrorInfo attempt failure as a SubscriptionFailed', async () => {
    const guard = new ConnectGuard();
    await expect(guard.connect(vi.fn<() => Promise<void>>().mockRejectedValue(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(guard.requireConnected('send')).rejects.toBeErrorInfo({
      code: ErrorCode.SubscriptionFailed,
      statusCode: 500,
      message: 'unable to send; connect() failed, call connect() again to retry; boom',
    });
  });
});

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

describe('continuityLostError', () => {
  it('builds a ContinuityNotGuaranteed error with the given verb and the state reason as cause', () => {
    const reason = new Ably.ErrorInfo('attach failed', 80002, 500);
    const err = continuityLostError(stateChange('suspended', true, reason), 'deliver events');
    expect(err).toBeErrorInfo({
      code: ErrorCode.ContinuityNotGuaranteed,
      statusCode: 500,
      message: 'unable to deliver events; channel continuity lost (suspended)',
    });
    expect(err.cause).toBe(reason);
  });

  it('annotates an un-resumed re-attach with resumed: false', () => {
    const err = continuityLostError(stateChange('attached', false), 'continue');
    expect(err.message).toBe('unable to continue; channel continuity lost (attached, resumed: false)');
  });
});

describe('subscribeAndAttach', () => {
  it('subscribes the listener, attaches the channel, and resolves on success', async () => {
    const subscribe = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());
    const attach = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());
    const channel = { subscribe, attach, unsubscribe: vi.fn() } as unknown as Ably.RealtimeChannel;
    const onError = vi.fn();

    await expect(
      subscribeAndAttach(channel, noopListener, silentLogger, 'ClientTransport', onError),
    ).resolves.toBeUndefined();
    expect(subscribe).toHaveBeenCalledWith(noopListener);
    // attach() is forced after subscribe: subscribe's implicit attach can resolve
    // with the channel still INITIALIZED, so the explicit attach guarantees the
    // write guard sees an ATTACHED/ATTACHING channel by the time connect() resolves.
    expect(attach).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('wraps a subscribe failure, reports it via onError, and rejects with the same error', async () => {
    const cause = new Ably.ErrorInfo('attach refused', 40160, 401);
    const subscribe = vi.fn<() => Promise<void>>().mockRejectedValue(cause);
    const attach = vi.fn<() => Promise<void>>().mockReturnValue(Promise.resolve());
    const channel = { subscribe, attach, unsubscribe: vi.fn() } as unknown as Ably.RealtimeChannel;
    const onError = vi.fn();

    const rejection = subscribeAndAttach(channel, noopListener, silentLogger, 'AgentTransport', onError);
    await expect(rejection).rejects.toBeErrorInfo({
      code: ErrorCode.SubscriptionFailed,
      statusCode: 500,
      message: 'unable to subscribe and attach channel; attach refused',
      cause,
    });
    // The same error instance is both surfaced and thrown — never two deliveries.
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

    const rejection = subscribeAndAttach(channel, noopListener, silentLogger, 'ClientTransport', onError);
    await expect(rejection).rejects.toBeErrorInfo({
      code: ErrorCode.SubscriptionFailed,
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

    await subscribeAndAttach(channel, noopListener, silentLogger, 'ClientTransport', vi.fn());

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
  it('wraps a thrown value as a MessageProcessingFailed preserving the cause', () => {
    const cause = new Ably.ErrorInfo('boom', 50000, 500);
    expect(wrapMessageProcessingError(cause)).toBeErrorInfo({
      code: ErrorCode.MessageProcessingFailed,
      statusCode: 500,
      message: 'unable to process channel message; boom',
      cause,
    });
  });
});

describe('reportPage', () => {
  it('invokes the callback when one is supplied', () => {
    const onPage = vi.fn();
    reportPage(onPage, 'locateInput', silentLogger);
    expect(onPage).toHaveBeenCalledOnce();
  });

  it('is a no-op when no callback is supplied', () => {
    expect(() => {
      reportPage(undefined, 'locateInput', silentLogger);
    }).not.toThrow();
  });

  it('swallows a callback throw and logs it at error', () => {
    const logged: { message: string; level: LogLevel }[] = [];
    const logHandler: LogHandler = (message: string, level: LogLevel) => {
      logged.push({ message, level });
    };
    const logger = makeLogger({ logLevel: LogLevel.Error, logHandler });

    expect(() => {
      reportPage(
        () => {
          throw new Error('heartbeat exploded');
        },
        'locateInput',
        logger,
      );
    }).not.toThrow();
    expect(
      logged.some((l) => l.level === LogLevel.Error && l.message.includes('reportPage(); onPage callback threw')),
    ).toBe(true);
  });

  it('swallows a callback throw with no logger', () => {
    expect(() => {
      reportPage(() => {
        throw new Error('heartbeat exploded');
      }, 'locateInput');
    }).not.toThrow();
  });
});
