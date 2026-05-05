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

/**
 * Connect a freshly created agent session, race a `simulateRunStart` against
 * the createRun precondition wait, and resolve to the bound `AgentRun`.
 * Drops the boilerplate "kick off createRun, drive run-start, await
 * promise" pattern from individual tests.
 * @param session The agent session to operate on (must be connectable).
 * @param channel The mock channel feeding the session.
 * @param runId The run id to bind to.
 * @param clientId The initiator id baked onto the run-start.
 * @returns The live `AgentRun` once preconditions are satisfied.
 */
const connectAndCreateRun = async (
  session: ReturnType<typeof createAgentSession<StubCodec>>,
  channel: ReturnType<typeof createMockChannel>,
  runId = 'r-1',
  clientId = 'alice',
) => {
  await session.connect();
  const promise = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId }));
  simulateRunStart(channel, runId, clientId);
  return promise;
};

describe('AgentSession.createRun', () => {
  it('returns a handle bound to invocation.runId once the run-start lands', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);

    const run = await connectAndCreateRun(session, channel, 'r-1', 'alice');

    expect(run.id).toBe('r-1');
  });

  it('rejects an invocation whose sessionName does not match the session', async () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    const invocation = Invocation.fromJSON({ sessionName: 'other-session', runId: 'r-1' });

    await expect(session.createRun(invocation)).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('rejects with SessionClosed after the session has been closed', async () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    await session.close();
    const invocation = Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' });

    await expect(session.createRun(invocation)).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
  });

  it('exposes status and initiatorClientId from the run-start that satisfied the precondition', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);

    const run = await connectAndCreateRun(session, channel, 'r-1', 'alice');

    expect(run.status).toBe('active');
    expect(run.initiatorClientId).toBe('alice');
  });

  it('waits for invocation.messageId to be visible before resolving', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const invocation = Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1', messageId: 'm-1' });

    const promise = session.createRun(invocation);

    // Driving only the run-start is not enough — the messageId precondition
    // is still outstanding, so the promise must remain pending.
    simulateRunStart(channel, 'r-1', 'alice');
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    channel.simulateMessage({
      name: 'x-ably-message',
      data: 'hello',
      serial: '02',
      clientId: 'alice',
      extras: {
        headers: { [Headers.MessageId]: 'm-1', [Headers.Role]: 'user', [Headers.RunId]: 'r-1' },
      },
    } as unknown as Ably.InboundMessage);

    const run = await promise;
    expect(run.id).toBe('r-1');
  });

  it("waits for invocation.messageId to be visible as a control signal on the run's controlSignals (retry path)", async () => {
    // Retry happy path: ClientRun.retry() returns an Invocation whose
    // messageId is the retry signal's wire id. AgentSession.createRun
    // resolves once the signal is visible on the targeted run, not
    // before — so the agent doesn't start a fresh step ahead of the
    // retry being durably observable to other clients.
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    simulateRunStart(channel, 'r-1', 'alice');
    const invocation = Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1', messageId: 'sig-1' });

    const promise = session.createRun(invocation);
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    channel.simulateMessage({
      name: WireMessages.Retry,
      serial: '02',
      clientId: 'alice',
      extras: {
        headers: {
          [Headers.RunId]: 'r-1',
          [Headers.MessageId]: 'sig-1',
          [Headers.Reason]: 'retry',
        },
      },
    } as unknown as Ably.InboundMessage);

    const run = await promise;
    expect(run.id).toBe('r-1');
    expect(run.controlSignals.some((s) => s.messageId === 'sig-1' && s.type === 'retry')).toBe(true);
  });

  it('rejects with InvocationPreconditionTimeout when the run-start never lands', async () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const invocation = Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' });

    await expect(session.createRun(invocation, { timeoutMs: 5 })).rejects.toBeErrorInfoWithCode(
      ErrorCode.InvocationPreconditionTimeout,
    );
  });

  it('rejects with InvocationPreconditionTimeout when the caller signal aborts', async () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const invocation = Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' });
    const ac = new AbortController();

    const promise = session.createRun(invocation, { signal: ac.signal });
    ac.abort();

    await expect(promise).rejects.toBeErrorInfoWithCode(ErrorCode.InvocationPreconditionTimeout);
  });

  it('resolves even when the run has an abort signal observed (symmetric model — signals never terminate)', async () => {
    // Under the symmetric model, observing an abort signal on the channel
    // does not terminate the run. createRun resolves; the agent processes
    // the signal during its step and decides whether to publish run-end
    // (aborted). This is what makes retry-after-abort work.
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const invocation = Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' });

    const promise = session.createRun(invocation);
    channel.simulateMessage({
      name: WireMessages.RunStart,
      serial: '01',
      clientId: 'agent-1',
      extras: { headers: { [Headers.RunId]: 'r-1' } },
    } as unknown as Ably.InboundMessage);
    channel.simulateMessage({
      name: WireMessages.Abort,
      serial: '02',
      clientId: 'alice',
      extras: {
        headers: {
          [Headers.RunId]: 'r-1',
          [Headers.MessageId]: 'sig-1',
          [Headers.Reason]: 'aborted',
        },
      },
    } as unknown as Ably.InboundMessage);

    const run = await promise;
    expect(run.id).toBe('r-1');
    expect(run.controlSignals.map((s) => s.messageId)).toEqual(['sig-1']);
  });

  it('run.messages filters by run id; run.view.messages exposes the linear tree across runs', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);

    const run = await connectAndCreateRun(session, channel, 'r-1', 'alice');

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

    // run.messages stays scoped to the bound run — it's the agent-side
    // "what did this run produce" surface.
    expect(run.messages.map((n) => n.id)).toEqual(['m-1']);
    // run.view.messages is the linear conversation the agent passes to the
    // model and includes ancestry from prior runs on the session.
    expect(run.view.messages.map((n) => n.id)).toEqual(['m-1', 'm-2']);
  });
});

describe('AgentRun.end', () => {
  it("publishes x-ably-run-end with status='complete' on the happy path", async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);

    await run.end();

    // Two publishes total: the run-start the test simulated arrives via
    // simulateMessage (no publish), so the only publish is the run-end.
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
    const run = await connectAndCreateRun(session, channel);

    await run.end(new Error('agent threw'));

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('failed');
  });

  it("publishes status='aborted' when called with an AbortError (signal-driven path)", async () => {
    // Symmetric classifier: 'aborted' is selected purely from the error
    // shape — a web-standard AbortError. The classifier no longer reads
    // any tree state; observation of the abort signal is what fires
    // step.signal, the model throws AbortError, and the classifier
    // recognises the throw as signal-driven.
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);

    const step = run.createStep();
    const startPromise = step.start();
    channel.simulateMessage({
      name: 'x-ably-step-start',
      serial: '02',
      extras: { headers: { 'x-ably-run-id': 'r-1', 'x-ably-step-id': step.id } },
    } as unknown as Ably.InboundMessage);
    await startPromise;

    const abortError = new DOMException('aborted', 'AbortError');
    await step.end(abortError);
    await run.end(abortError);

    const lastBatch = channel.publishedBatches.at(-1) ?? [];
    const [wire] = lastBatch;
    if (!wire) throw new Error('expected run-end wire');
    expect(wire.name).toBe(WireMessages.RunEnd);
    expect(headersOf(wire)[Headers.Status]).toBe('aborted');
  });

  it("publishes status='failed' when an error is supplied without an aborted bound step", async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);

    // Open a step but never abort its signal — the abort row of the
    // classifier should not fire, and end(error) routes to 'failed'.
    const step = run.createStep();
    const startPromise = step.start();
    channel.simulateMessage({
      name: 'x-ably-step-start',
      serial: '02',
      extras: { headers: { 'x-ably-run-id': 'r-1', 'x-ably-step-id': step.id } },
    } as unknown as Ably.InboundMessage);
    await startPromise;

    await run.end(new Error('non-abort error'));

    const lastBatch = channel.publishedBatches.at(-1) ?? [];
    const [wire] = lastBatch;
    if (!wire) throw new Error('expected run-end wire');
    expect(wire.name).toBe(WireMessages.RunEnd);
    expect(headersOf(wire)[Headers.Status]).toBe('failed');
  });

  it("publishes status='complete' when no error is supplied even with an abort signal observed", async () => {
    // Symmetric classifier: status comes from the error argument alone.
    // A late abort observation that the agent's handler chose to ignore
    // (because the step decided "done") does not retroactively change
    // the run's terminal status.
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);

    channel.simulateMessage({
      name: WireMessages.Abort,
      serial: '02',
      clientId: 'alice',
      extras: {
        headers: {
          [Headers.RunId]: 'r-1',
          [Headers.MessageId]: 'sig-1',
          [Headers.Reason]: 'aborted',
        },
      },
    } as unknown as Ably.InboundMessage);

    await run.end();

    const lastBatch = channel.publishedBatches.at(-1) ?? [];
    const [wire] = lastBatch;
    if (!wire) throw new Error('expected run-end wire');
    expect(wire.name).toBe(WireMessages.RunEnd);
    expect(headersOf(wire)[Headers.Status]).toBe('complete');
  });

  it("publishes status='failed' when a genuine error coincides with an observed abort (failed wins, retryable)", async () => {
    // Spec: AIT-AB7 row 2. A genuine (non-signal-driven) error wins over a
    // coincident abort observation. Failed runs are retryable; aborted
    // runs are not — so the distinction is load-bearing.
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);

    // Open a step but never abort its signal — the developer didn't wire
    // step.signal into the model SDK, so signal.reason is undefined.
    const step = run.createStep();
    const startPromise = step.start();
    channel.simulateMessage({
      name: 'x-ably-step-start',
      serial: '02',
      extras: { headers: { 'x-ably-run-id': 'r-1', 'x-ably-step-id': step.id } },
    } as unknown as Ably.InboundMessage);
    await startPromise;

    // Abort observed during the step.
    channel.simulateMessage({
      name: WireMessages.Abort,
      serial: '03',
      clientId: 'alice',
      extras: {
        headers: {
          [Headers.RunId]: 'r-1',
          [Headers.MessageId]: 'sig-1',
          [Headers.Reason]: 'aborted',
        },
      },
    } as unknown as Ably.InboundMessage);

    // Now the model throws an unrelated network error.
    await run.end(new Error('network error from model'));

    const lastBatch = channel.publishedBatches.at(-1) ?? [];
    const [wire] = lastBatch;
    if (!wire) throw new Error('expected run-end wire');
    expect(headersOf(wire)[Headers.Status]).toBe('failed');
  });

  it('is idempotent — a second call publishes nothing', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);

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
    const run = await connectAndCreateRun(session, channel);

    await expect(run.end()).rejects.toBeErrorInfoWithCauseCode(50000);
  });
});

describe('AgentRun.close', () => {
  it('calls end() if the run has not been ended and closes the view', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);
    const handler = vi.fn();
    run.view.subscribe(handler);

    await run.close();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('complete');

    handler.mockReset();
    simulateRunStart(channel, 'r-2', 'alice', '02');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not re-publish when end() has already been called', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);

    await run.end(new Error('explicit failure'));
    await run.close();

    expect(channel.publish).toHaveBeenCalledTimes(1);
  });

  it('Symbol.asyncDispose delegates to close()', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);

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
    const run = await connectAndCreateRun(session, channel);

    await run[Symbol.asyncDispose]();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('complete');
  });

  it('does not re-publish when end() has already been called', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);

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
    const run = await connectAndCreateRun(session, channel);
    const handler = vi.fn();
    run.view.subscribe(handler);

    await run[Symbol.asyncDispose]();
    handler.mockReset();

    // Drive an inbound after dispose — a still-live view would re-fire its
    // subscribers; the closed view must not.
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
    const run = await connectAndCreateRun(session, channel);

    await expect(run[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});

describe('AgentSession.close', () => {
  it("closes a run's view as part of session teardown", async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    const run = await connectAndCreateRun(session, channel);
    const handler = vi.fn();
    run.view.subscribe(handler);

    await session.close();
    handler.mockReset();

    // After session.close the agent view must no longer fire — drive an
    // inbound and confirm silence. The inbound is only meaningful before
    // close, so the assertion is that the view's tree subscription was
    // severed during teardown.
    simulateRunStart(channel, 'r-2', 'alice', '02');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('AgentSession precondition resolution', () => {
  it('resolves createRun once the run-start that satisfies the precondition lands live', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();

    // Kick off createRun before the run-start arrives — the promise is
    // pending until simulateRunStart drives it.
    const promise = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    simulateRunStart(channel, 'r-1', 'alice');

    const run = await promise;
    expect(run.initiatorClientId).toBe('alice');
  });

  it('AgentSession.createRun is reachable from a session created via createClientSession too', async () => {
    // The runtime object is shared between client and agent flavours; this
    // confirms the codec parameter flows through both. The cast is the same
    // pattern other tests use for surface-not-yet-on-the-public-type.
    const { options, channel } = makeAgentSession();
    const session = createClientSession(options);
    await session.connect();

    // CAST: ClientSession's runtime object also exposes createRun via
    //       declaration merging on the underlying class. Phase 7's public
    //       ClientSession type omits createRun deliberately.
    const reach = session as unknown as {
      createRun: (i: ReturnType<typeof Invocation.fromJSON>) => Promise<unknown>;
    };
    const promise = reach.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    simulateRunStart(channel, 'r-1', 'alice');
    const run = await promise;
    expect(run).toBeDefined();
  });
});
