import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { Invocation } from '../../../src/core/invocation/index.js';
import type { SessionOptions } from '../../../src/core/session/index.js';
import { createAgentSession } from '../../../src/core/session/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers, WireMessages } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { ABORTED } from '../../../src/signal-reason.js';
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

  it('rejects with StepStartAborted and does not publish when the supplied signal is already aborted', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();
    const ac = new AbortController();
    ac.abort();

    await expect(step.start({ signal: ac.signal })).rejects.toBeErrorInfoWithCode(ErrorCode.StepStartAborted);

    expect(channel.publish).not.toHaveBeenCalled();
    expect(step.signal.aborted).toBe(true);
    expect(step.signal.reason).toBe(ABORTED);
  });

  it('rejects with StepStartAborted when the caller signal fires before the tree observes the publish', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();
    const ac = new AbortController();

    const startPromise = step.start({ signal: ac.signal });
    await Promise.resolve();
    // The publish has been issued; the decode loop has not yet observed it.
    expect(channel.publish).toHaveBeenCalledTimes(1);

    ac.abort();

    await expect(startPromise).rejects.toBeErrorInfoWithCode(ErrorCode.StepStartAborted);
    expect(step.signal.aborted).toBe(true);
    expect(step.signal.reason).toBe(ABORTED);
  });

  it('rejects with StepStartAborted when timeoutMs elapses before the tree observes the publish', async () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    // Tiny timeout so the test does not wait long; the publish is awaited
    // synchronously by the mock channel, after which the wait for the tree
    // observation never resolves — the timeout fires the signal and the
    // start() promise rejects.
    await expect(step.start({ timeoutMs: 5 })).rejects.toBeErrorInfoWithCode(ErrorCode.StepStartAborted);
    expect(step.signal.aborted).toBe(true);
    expect(step.signal.reason).toBe(ABORTED);
  });

  it('clears the timeout when the step-start lands before timeoutMs elapses', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    const startPromise = step.start({ timeoutMs: 50_000 });
    await Promise.resolve();
    simulateStepStart(channel, 'r-1', step.id);

    await startPromise;

    expect(step.signal.aborted).toBe(false);
  });

  it('propagates a caller signal abort to step.signal after start() resolves (lifetime)', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();
    const ac = new AbortController();

    const startPromise = step.start({ signal: ac.signal });
    await Promise.resolve();
    simulateStepStart(channel, 'r-1', step.id);
    await startPromise;
    expect(step.signal.aborted).toBe(false);

    // Caller signal fires post-resolution — step.signal should track it
    // because the listener composes for the step's lifetime.
    ac.abort();

    expect(step.signal.aborted).toBe(true);
    expect(step.signal.reason).toBe(ABORTED);
  });
});

describe('Step.pipe', () => {
  it('encodes each chunk in arrival order with x-ably-role=assistant and run-id', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    const readable = new ReadableStream<string>({
      start: (controller) => {
        controller.enqueue('chunk-1');
        controller.enqueue('chunk-2');
        controller.enqueue('chunk-3');
        controller.close();
      },
    });

    await step.pipe(readable);

    // The stub codec routes encodePart through `core.publish` — one
    // channel.publish per chunk, in arrival order.
    expect(channel.publish).toHaveBeenCalledTimes(3);
    const wires = channel.publishedBatches.map((batch) => {
      expect(batch).toHaveLength(1);
      return batch[0];
    });
    // CAST: Ably.Message.data is typed any; this test produced strings.
    expect(wires.map((wire) => wire?.data as string | undefined)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);

    // Every wire shares the same writer-assigned msg-id and carries the
    // assistant role + run-id from the step.
    const ids = new Set<string | undefined>();
    for (const wire of wires) {
      if (!wire) throw new Error('expected one wire per published batch');
      const headers = headersOf(wire);
      expect(headers[Headers.Role]).toBe('assistant');
      expect(headers[Headers.RunId]).toBe('r-1');
      ids.add(headers[Headers.MessageId]);
    }
    expect(ids.size).toBe(1);
    expect(typeof [...ids][0]).toBe('string');
  });

  it('does nothing when the readable closes immediately', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    const readable = new ReadableStream<string>({
      start: (controller) => {
        controller.close();
      },
    });

    await step.pipe(readable);

    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('exits cleanly without publishing any chunk when step.signal aborts before pipe starts pulling', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();
    const ac = new AbortController();

    const startPromise = step.start({ signal: ac.signal });
    await Promise.resolve();
    simulateStepStart(channel, 'r-1', step.id);
    await startPromise;

    // step-start was the only publish so far.
    const publishCountAfterStart = channel.publish.mock.calls.length;

    // Abort before pulling — the pipe's while condition exits on the
    // first signal check, so no chunk is encoded.
    ac.abort();

    const readable = new ReadableStream<string>({
      start: (controller) => {
        controller.enqueue('chunk-1');
        controller.enqueue('chunk-2');
        controller.enqueue('chunk-3');
        controller.close();
      },
    });
    await step.pipe(readable);

    expect(channel.publish.mock.calls.length).toBe(publishCountAfterStart);
    expect(step.signal.aborted).toBe(true);
  });

  it('honours mid-stream abort across iterations: chunks pushed after the abort are not published', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();
    const ac = new AbortController();

    const startPromise = step.start({ signal: ac.signal });
    await Promise.resolve();
    simulateStepStart(channel, 'r-1', step.id);
    await startPromise;

    const publishCountAfterStart = channel.publish.mock.calls.length;

    // Hand-rolled controller-driven stream so the test can interleave
    // chunks with the caller-signal abort.
    let controller: ReadableStreamDefaultController<string> | undefined;
    const readable = new ReadableStream<string>({
      start: (c) => {
        controller = c;
      },
    });
    if (!controller) throw new Error('expected stream controller');

    const pipePromise = step.pipe(readable);

    controller.enqueue('chunk-1');
    // Wait until the encoder has issued one publish for chunk-1 — the
    // encode chain spans several microtasks, so polling avoids brittle
    // microtask counting.
    await vi.waitFor(() => {
      expect(channel.publish.mock.calls.length).toBe(publishCountAfterStart + 1);
    });

    ac.abort();
    controller.close();

    await pipePromise;

    expect(channel.publish.mock.calls.length).toBe(publishCountAfterStart + 1);
    expect(step.signal.aborted).toBe(true);
  });
});

describe('Step.end', () => {
  it("publishes x-ably-step-end with status='complete' on the happy path", async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    await step.end();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(wire.name).toBe(WireMessages.StepEnd);
    const headers = headersOf(wire);
    expect(headers[Headers.RunId]).toBe('r-1');
    expect(headers[Headers.StepId]).toBe(step.id);
    expect(headers[Headers.Status]).toBe('complete');
  });

  it("publishes status='failed' when called with an error", async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    await step.end(new Error('agent threw'));

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('failed');
  });

  it('is idempotent — a second call publishes nothing', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    await step.end();
    await step.end();
    await step.end(new Error('late error'));

    expect(channel.publish).toHaveBeenCalledTimes(1);
  });

  it('reports the locally derived terminal status before the publish echoes back through the tree', async () => {
    const { options } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    await step.end();

    expect(step.status).toBe('complete');
  });

  it('wraps the underlying publish error and preserves the cause', async () => {
    const { options, channel } = makeAgentSession();
    const publishError = new Ably.ErrorInfo('publish failed', 50000, 500);
    channel.publish.mockRejectedValueOnce(publishError);
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    await expect(step.end()).rejects.toBeErrorInfoWithCauseCode(50000);
  });
});

describe('Step[Symbol.asyncDispose]', () => {
  it('calls end() if the step has not been ended', async () => {
    const { options, channel } = makeAgentSession();
    const session = createAgentSession(options);
    await session.connect();
    const run = session.createRun(Invocation.fromJSON({ sessionName: 'session-1', runId: 'r-1' }));
    const step = run.createStep();

    await step[Symbol.asyncDispose]();

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
    const step = run.createStep();

    await step.end(new Error('explicit failure'));
    await step[Symbol.asyncDispose]();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('failed');
  });
});
