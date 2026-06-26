import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import {
  bestEffortDetach,
  continuityLostError,
  handleWireMessage,
  isContinuityLost,
  requireConnected,
  subscribeAndAttach,
  wrapMessageProcessingError,
} from '../../../src/core/transport/session-support.js';
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

describe('requireConnected', () => {
  it('returns the connect promise when connected', async () => {
    const connectPromise = Promise.resolve();
    await expect(requireConnected(connectPromise, 'send')).resolves.toBeUndefined();
  });

  it('rejects with InvalidArgument when not connected', async () => {
    await expect(requireConnected(undefined, 'send')).rejects.toBeErrorInfo({
      code: ErrorCode.InvalidArgument,
      statusCode: 400,
      message: 'unable to send; connect() must be called before send()',
    });
  });
});

describe('bestEffortDetach', () => {
  it('does not detach when there is no connect promise', async () => {
    const detach = vi.fn();
    const channel = { detach } as unknown as Ably.RealtimeChannel;
    await bestEffortDetach(channel, undefined, undefined, 'ClientSession');
    expect(detach).not.toHaveBeenCalled();
  });

  it('detaches when connected', async () => {
    const detach = vi.fn();
    const channel = { detach } as unknown as Ably.RealtimeChannel;
    await bestEffortDetach(channel, Promise.resolve(), undefined, 'ClientSession');
    expect(detach).toHaveBeenCalledOnce();
  });

  it('swallows a detach failure and logs it at debug', async () => {
    const detach = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('already failed'));
    const channel = { detach } as unknown as Ably.RealtimeChannel;
    const logged: { message: string; level: LogLevel }[] = [];
    const logHandler: LogHandler = (message: string, level: LogLevel) => {
      logged.push({ message, level });
    };
    const logger = makeLogger({ logLevel: LogLevel.Debug, logHandler });

    await expect(bestEffortDetach(channel, Promise.resolve(), logger, 'DefaultAgentSession')).resolves.toBeUndefined();
    expect(logged.some((l) => l.level === LogLevel.Debug && l.message.includes('DefaultAgentSession.close();'))).toBe(
      true,
    );
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
  it('builds a ChannelContinuityLost error with the given verb and the state reason as cause', () => {
    const reason = new Ably.ErrorInfo('attach failed', 80002, 500);
    const err = continuityLostError(stateChange('suspended', true, reason), 'deliver events');
    expect(err).toBeErrorInfo({
      code: ErrorCode.ChannelContinuityLost,
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
    const channel = { subscribe, attach } as unknown as Ably.RealtimeChannel;
    const onError = vi.fn();

    await expect(
      subscribeAndAttach(channel, noopListener, silentLogger, 'DefaultClientSession', onError),
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
    const channel = { subscribe, attach } as unknown as Ably.RealtimeChannel;
    const onError = vi.fn();

    const rejection = subscribeAndAttach(channel, noopListener, silentLogger, 'DefaultAgentSession', onError);
    await expect(rejection).rejects.toBeErrorInfo({
      code: ErrorCode.SessionSubscriptionError,
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
    const channel = { subscribe, attach } as unknown as Ably.RealtimeChannel;
    const onError = vi.fn();

    const rejection = subscribeAndAttach(channel, noopListener, silentLogger, 'DefaultClientSession', onError);
    await expect(rejection).rejects.toBeErrorInfo({
      code: ErrorCode.SessionSubscriptionError,
      statusCode: 500,
      message: 'unable to subscribe and attach channel; attach timed out',
      cause,
    });
    const surfaced = onError.mock.calls[0]?.[0] as Ably.ErrorInfo;
    await expect(rejection.catch((error: unknown) => error)).resolves.toBe(surfaced);
  });
});

describe('wrapMessageProcessingError', () => {
  it('wraps a thrown value as a SessionSubscriptionError preserving the cause', () => {
    const cause = new Ably.ErrorInfo('boom', 50000, 500);
    expect(wrapMessageProcessingError(cause)).toBeErrorInfo({
      code: ErrorCode.SessionSubscriptionError,
      statusCode: 500,
      message: 'unable to process channel message; boom',
      cause,
    });
  });
});

describe('handleWireMessage', () => {
  it('runs the body and does not call onError when it succeeds', () => {
    const onError = vi.fn();
    const body = vi.fn();
    handleWireMessage(body, onError);
    expect(body).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes a body throw through onError as a wrapped processing error', () => {
    const onError = vi.fn();
    handleWireMessage(() => {
      throw new Error('bad message');
    }, onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeErrorInfo({
      code: ErrorCode.SessionSubscriptionError,
      statusCode: 500,
      message: 'unable to process channel message; bad message',
    });
  });
});
