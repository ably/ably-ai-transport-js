import '../../helper/expectations.js';

import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { publishLifecycleEvent } from '../../../src/core/transport/lifecycle-publish.js';
import { ErrorCode } from '../../../src/errors.js';
import { type LogHandler, LogLevel, makeLogger } from '../../../src/logger.js';

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

/**
 * A publish that resolves with `serial`.
 * @param serial - The ACK serial the publish reports.
 * @returns The publish thunk.
 */
const publishOk = (serial: string) => vi.fn<() => Promise<string>>().mockResolvedValue(serial);

/**
 * A publish that rejects with `error`.
 * @param error - The failure the publish rejects with.
 * @returns The publish thunk.
 */
const publishFails = (error: unknown) => vi.fn<() => Promise<never>>().mockRejectedValue(error);

describe('publishLifecycleEvent', () => {
  it('returns the publish result untouched on success', async () => {
    await expect(
      publishLifecycleEvent(
        { phase: 'step-start', method: 'openStep', runId: 'run-1', logger: silentLogger },
        publishOk('serial-1'),
      ),
    ).resolves.toBe('serial-1');
  });

  it('wraps a publish failure as RunLifecycleEventPublishFailed, naming the phase and run', async () => {
    const cause = new Ably.ErrorInfo('publish refused', 40160, 401);
    await expect(
      publishLifecycleEvent(
        { phase: 'run-start', method: 'start', runId: 'run-1', logger: silentLogger },
        publishFails(cause),
      ),
    ).rejects.toBeErrorInfo({
      code: ErrorCode.RunLifecycleEventPublishFailed,
      statusCode: 500,
      message: 'unable to publish run-start for run run-1; publish refused',
      cause,
    });
  });

  it('wraps a non-ErrorInfo failure, leaving no cause to preserve', async () => {
    await expect(
      publishLifecycleEvent(
        { phase: 'run-end', method: 'end', runId: 'run-2', logger: silentLogger },
        publishFails(new Error('socket closed')),
      ),
    ).rejects.toBeErrorInfo({
      code: ErrorCode.RunLifecycleEventPublishFailed,
      statusCode: 500,
      message: 'unable to publish run-end for run run-2; socket closed',
    });
  });

  it('logs the failure at error with the run, and the caller-supplied context', async () => {
    const handler = vi.fn<LogHandler>();
    const logger = makeLogger({ logLevel: LogLevel.Error, logHandler: handler });

    await expect(
      publishLifecycleEvent(
        { phase: 'step-end', method: 'closeStep', runId: 'run-1', logger, logContext: { stepId: 'step-7' } },
        publishFails(new Error('publish failed')),
      ),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.RunLifecycleEventPublishFailed);

    expect(handler).toHaveBeenCalledWith(
      'Run.closeStep(); failed to publish step-end',
      LogLevel.Error,
      expect.objectContaining({ runId: 'run-1', stepId: 'step-7' }),
    );
  });

  it('does not log when the publish succeeds', async () => {
    const handler = vi.fn<LogHandler>();
    const logger = makeLogger({ logLevel: LogLevel.Error, logHandler: handler });

    await publishLifecycleEvent(
      { phase: 'run-suspend', method: 'suspend', runId: 'run-1', logger },
      publishOk('serial-1'),
    );

    expect(handler).not.toHaveBeenCalled();
  });
});
