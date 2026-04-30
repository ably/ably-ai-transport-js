import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { Invocation } from '../../../src/core/invocation/index.js';
import type { SessionOptions } from '../../../src/core/session/index.js';
import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
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
 * Drive an inbound `x-ably-run-start` for the given run id. Use this in
 * tests that want the agent's session tree to see the run before reading
 * status/initiator from the AgentRun handle.
 * @param channel The mock channel.
 * @param runId The run id to start.
 * @param clientId The publishing connection's clientId (the run's initiator).
 * @param serial The Ably message serial to attach.
 */
const simulateRunStart = (
  channel: ReturnType<typeof createMockChannel>,
  runId: string,
  clientId: string,
  serial = '01',
): void => {
  channel.simulateMessage({
    name: WireMessages.RunStart,
    serial,
    clientId,
    extras: { headers: { [Headers.RunId]: runId } },
  } as unknown as Ably.InboundMessage);
};

describe('AgentSession.createRun', () => {
  it('returns a handle bound to invocation.runId', () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    const invocation = Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' });

    const run = session.createRun(invocation);

    expect(run.id).toBe('r-1');
  });

  it('rejects an invocation whose sessionName does not match the session', () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    const invocation = Invocation.fromJSON({ sessionName: 'other-session', runId: 'r-1' });

    expect(() => session.createRun(invocation)).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('throws SessionClosed after the session has been closed', async () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    await session.close();
    const invocation = Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' });

    expect(() => session.createRun(invocation)).toThrowErrorInfoWithCode(ErrorCode.SessionClosed);
  });

  it('exposes status and initiatorClientId once the run-start lands on the tree', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const invocation = Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' });
    const run = session.createRun(invocation);

    // Before the run-start arrives, status is the optimistic 'active' default
    // and initiator is the empty string (the handle pends).
    expect(run.status).toBe('active');
    expect(run.initiatorClientId).toBe('');

    simulateRunStart(channel, 'r-1', 'alice');

    expect(run.status).toBe('active');
    expect(run.initiatorClientId).toBe('alice');
  });

  it('view.messages and run.messages filter the tree by the bound run id', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    simulateRunStart(channel, 'r-1', 'alice');
    simulateRunStart(channel, 'r-2', 'alice', '02');
    // Two content messages — one for r-1, one for r-2.
    channel.simulateMessage({
      name: 'x-ably-message',
      data: 'hello-r1',
      serial: '03',
      clientId: 'alice',
      extras: {
        headers: {
          [Headers.MessageId]: 'm-1',
          [Headers.Role]: 'user',
          [Headers.RunId]: 'r-1',
        },
      },
    } as unknown as Ably.InboundMessage);
    channel.simulateMessage({
      name: 'x-ably-message',
      data: 'hello-r2',
      serial: '04',
      clientId: 'alice',
      extras: {
        headers: {
          [Headers.MessageId]: 'm-2',
          [Headers.Role]: 'user',
          [Headers.RunId]: 'r-2',
        },
      },
    } as unknown as Ably.InboundMessage);

    expect(run.messages.map((n) => n.id)).toEqual(['m-1']);
    expect(run.view.messages.map((n) => n.id)).toEqual(['m-1']);
  });
});

describe('AgentRun.end', () => {
  it("publishes x-ably-run-end with status='complete' on the happy path", async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    await run.end();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const batch = channel.publishedBatches[0] ?? [];
    expect(batch).toHaveLength(1);
    const [wire] = batch;
    if (!wire) throw new Error('expected one wire message');
    expect(wire.name).toBe(WireMessages.RunEnd);
    expect(headersOf(wire)[Headers.RunId]).toBe('r-1');
    expect(headersOf(wire)[Headers.Status]).toBe('complete');
  });

  it("publishes status='failed' when called with an error", async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    await run.end(new Error('agent threw'));

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('failed');
  });

  it('is idempotent — a second call publishes nothing', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    await run.end();
    await run.end();
    await run.end(new Error('late error'));

    expect(channel.publish).toHaveBeenCalledTimes(1);
  });

  it('wraps the underlying publish error and preserves the cause', async () => {
    const { options, channel } = makeAgentSession();
    const publishError = new Ably.ErrorInfo('publish failed', 50000, 500);
    channel.publish.mockRejectedValueOnce(publishError);
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    await expect(run.end()).rejects.toBeErrorInfoWithCauseCode(50000);
  });
});

describe('AgentRun.close', () => {
  it('calls end() if the run has not been ended and closes the view', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const handler = vi.fn();
    run.view.subscribe(handler);

    await run.close();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('complete');

    handler.mockReset();
    simulateRunStart(channel, 'r-1', 'alice', '02');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not re-publish when end() has already been called', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    await run.end(new Error('explicit failure'));
    await run.close();

    expect(channel.publish).toHaveBeenCalledTimes(1);
  });

  it('Symbol.asyncDispose delegates to close()', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    await run[Symbol.asyncDispose]();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('complete');
  });
});

describe('AgentRun[Symbol.asyncDispose]', () => {
  it('calls end() if the run has not been ended', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    await run[Symbol.asyncDispose]();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('complete');
  });

  it('does not re-publish when end() has already been called', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    await run.end(new Error('explicit failure'));
    await run[Symbol.asyncDispose]();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('failed');
  });

  it("closes the run's view so it stops firing subscribers", async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const handler = vi.fn();
    run.view.subscribe(handler);

    await run[Symbol.asyncDispose]();
    handler.mockReset();

    // Drive an inbound after dispose — a still-live view would re-fire its
    // subscribers; the closed view must not.
    simulateRunStart(channel, 'r-1', 'alice', '02');
    channel.simulateMessage({
      name: 'x-ably-message',
      data: 'after-dispose',
      serial: '03',
      clientId: 'alice',
      extras: {
        headers: {
          [Headers.MessageId]: 'm-after',
          [Headers.Role]: 'user',
          [Headers.RunId]: 'r-1',
        },
      },
    } as unknown as Ably.InboundMessage);

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not throw when end()s underlying publish fails — surfaces via logger', async () => {
    const { options, channel } = makeAgentSession();
    const publishError = new Ably.ErrorInfo('publish failed', 50000, 500);
    channel.publish.mockRejectedValueOnce(publishError);
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));

    await expect(run[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});

describe('AgentSession.close', () => {
  it("closes a run's view as part of session teardown", async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const handler = vi.fn();
    run.view.subscribe(handler);

    await session.close();
    handler.mockReset();

    // After session.close the agent view must no longer fire — drive an
    // inbound and confirm silence. The inbound is only meaningful before
    // close, so the assertion is that the view's tree subscription was
    // severed during teardown.
    simulateRunStart(channel, 'r-1', 'alice', '02');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('AgentSession lazy-read race', () => {
  it('createRun before connect() succeeds; tree reads return defaults until run-start lands', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);

    // createRun before connect — handle is built; the tree is empty.
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    expect(run.status).toBe('active');
    expect(run.initiatorClientId).toBe('');
    expect(run.messages).toEqual([]);

    // Once connected and run-start lands, lazy reads pick it up.
    await session.connect();
    simulateRunStart(channel, 'r-1', 'alice');
    expect(run.initiatorClientId).toBe('alice');
  });

  it('AgentSession.createRun is reachable from a session created via createClientSession too', async () => {
    // The runtime object is shared between client and agent flavours; this
    // confirms the codec parameter flows through both. The cast is the same
    // pattern other tests use for surface-not-yet-on-the-public-type.
    const { options } = makeAgentSession();
    const session = createClientSession(options);
    await session.connect();

    // CAST: ClientSession's runtime object also exposes createRun via
    //       declaration merging on the underlying class. Phase 7's public
    //       ClientSession type omits createRun deliberately.
    const reach = session as unknown as { createRun: (i: ReturnType<typeof Invocation.fromJSON>) => unknown };
    const run = reach.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    expect(run).toBeDefined();
  });
});
