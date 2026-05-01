import * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { Invocation } from '../../../src/core/invocation/index.js';
import type { SessionOptions } from '../../../src/core/session/index.js';
import { createAgentSession } from '../../../src/core/session/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers, WireMessages } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createMockChannel, createMockRealtime } from '../../helper/mock-realtime.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

const headersOf = (message: Ably.Message): Record<string, string> => {
  // CAST: tests own the structure of `extras` they passed in.
  const extras = message.extras as { headers?: Record<string, string> } | undefined;
  return extras?.headers ?? {};
};

const makeAgentSession = (clientId = 'agent-1') => {
  const channel = createMockChannel();
  const realtime = createMockRealtime(channel, { clientId });
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const options: SessionOptions<StubCodec> = {
    client: realtime,
    sessionName: 'session-1',
    codec: stubCodec,
    logger,
  };
  return { channel, realtime, options };
};

/**
 * Drive an inbound `x-ably-step-start` for the given run/step ids. Used to
 * complete `step.start()` in unit tests where the mock channel does not
 * echo a publish back to the same client.
 * @param channel The mock channel.
 * @param runId The run id the step belongs to.
 * @param stepId The step id to record.
 * @param serial The Ably message serial to attach.
 */
const simulateStepStart = (
  channel: ReturnType<typeof createMockChannel>,
  runId: string,
  stepId: string,
  serial = '01',
): void => {
  channel.simulateMessage({
    name: WireMessages.StepStart,
    serial,
    extras: { headers: { [Headers.RunId]: runId, [Headers.StepId]: stepId } },
  } as unknown as Ably.InboundMessage);
};

describe('AgentRun.createStep', () => {
  it('returns a step bound to the run id', () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    const step = run.createStep();

    expect(step.runId).toBe('r-1');
    expect(typeof step.id).toBe('string');
    expect(step.id.length).toBeGreaterThan(0);
  });

  it('reports status="pending" before start() resolves', () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    const step = run.createStep();

    expect(step.status).toBe('pending');
  });

  it('issues fresh step ids per createStep call', () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    const a = run.createStep();
    const b = run.createStep();

    expect(a.id).not.toBe(b.id);
  });
});

describe('Step.start', () => {
  it('publishes x-ably-step-start with run-id and step-id headers, then resolves once the tree records it', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    const startPromise = step.start();

    // start() is awaiting the inbound — flush the publish then deliver the
    // step-start back through the decode loop to unblock it.
    await Promise.resolve();
    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(wire.name).toBe(WireMessages.StepStart);
    expect(headersOf(wire)[Headers.RunId]).toBe('r-1');
    expect(headersOf(wire)[Headers.StepId]).toBe(step.id);

    simulateStepStart(channel, 'r-1', step.id);
    await startPromise;

    expect(step.status).toBe('active');
  });

  it('resolves immediately if the step-start is already on the tree', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    // Pre-seed the tree so start() finds the record on the synchronous
    // pre-publish check.
    simulateStepStart(channel, 'r-1', step.id);

    await step.start();

    expect(channel.publish).not.toHaveBeenCalled();
    expect(step.status).toBe('active');
  });

  it('wraps the underlying publish error and preserves the cause', async () => {
    const { options, channel } = makeAgentSession();
    const publishError = new Ably.ErrorInfo('publish failed', 50000, 500);
    channel.publish.mockRejectedValueOnce(publishError);
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    await expect(step.start()).rejects.toBeErrorInfoWithCauseCode(50000);
    expect(step.status).toBe('pending');
  });

  it('throws SessionClosed when the session is closed before start()', async () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();
    await session.close();

    await expect(step.start()).rejects.toBeErrorInfoWithCauseCode(ErrorCode.SessionClosed);
  });
});
