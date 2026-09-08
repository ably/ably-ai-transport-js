/**
 * Activity helper unit tests.
 *
 * `createAgentTransport` is mocked: the transport is covered by its own tests,
 * and mocking it leaves exactly what the helpers own observable — the order the
 * client and transport are built and torn down in, how a run is located and
 * opened or adopted, which hooks reach the transport, and how a step is keyed
 * and ended around the body.
 */

import '../helper/expectations.js';

import * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WireCodec } from '../../src/core/codec/types.js';
import { createAgentTransport } from '../../src/core/transport/agent-transport.js';
import { Invocation, type InvocationData } from '../../src/core/transport/invocation.js';
import type {
  AdoptRunOptions,
  LocatedInput,
  OpenRunHooks,
  OpenRunOptions,
  RunIdentity,
  StepOptions,
  TransportHistoryOptions,
} from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { type ActivityHelpersOptions, createActivityHelpers } from '../../src/temporal/activity-helpers.js';

vi.mock('../../src/core/transport/agent-transport.js', () => ({
  createAgentTransport: vi.fn(),
}));

/** The activity cancellation signal the Context stub hands out; reset per test. */
let mockCancellationSignal: AbortSignal = new AbortController().signal;
/** The heartbeat spy every stubbed activity Context hands out. */
const mockHeartbeat = vi.fn();
/** The activity's heartbeat timeout; undefined models an activity with none. */
let mockHeartbeatTimeoutMs: number | undefined = 30_000;
/** The Temporal activity id, which `withStep` keys its step on. */
const ACTIVITY_ID = 'act-7';

vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => ({
      cancellationSignal: mockCancellationSignal,
      heartbeat: mockHeartbeat,
      info: { heartbeatTimeoutMs: mockHeartbeatTimeoutMs, activityId: ACTIVITY_ID },
    }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TestInput {
  kind: string;
}
interface TestOutput {
  type: string;
}

const invocation: InvocationData = { inputEventId: 'evt-1', channelName: 'ai:room-7' };
const ids: RunIdentity = { runId: 'run-1', invocationId: 'wf-1' };

// CAST: the mocked transport never reads the codec.
const codec = { adapterTag: 'test' } as unknown as WireCodec<TestInput, TestOutput>;

interface StubStep {
  stepId: string;
  /** Flipped by `end`, and by the run's `end`, mirroring the core's auto-close of an open step. */
  ended: boolean;
  end: ReturnType<typeof vi.fn<(params?: { reason: string }) => Promise<void>>>;
}

interface StubRunHandle {
  runId: string;
  opened: Promise<void>;
  createStep: ReturnType<typeof vi.fn<(opts?: StepOptions) => StubStep>>;
  end: ReturnType<typeof vi.fn<(params: { reason: string; error?: unknown }) => Promise<void>>>;
}

interface StubTransport {
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  locateInput: ReturnType<typeof vi.fn<(eventId: string, opts?: TransportHistoryOptions) => Promise<unknown>>>;
  openRun: ReturnType<typeof vi.fn<(opts?: OpenRunOptions, hooks?: OpenRunHooks<TestOutput>) => StubRunHandle>>;
  adoptRun: ReturnType<
    typeof vi.fn<(runId: string, opts?: AdoptRunOptions, hooks?: OpenRunHooks<TestOutput>) => StubRunHandle>
  >;
}

/**
 * A located trigger with the given wire identity.
 * @param meta - The identity fields the helpers read.
 * @param meta.transportMessageId - The trigger's transport-message-id.
 * @param meta.runId - The run-id header, set on a continuation trigger.
 * @returns The located input.
 */
const located = (meta: { transportMessageId?: string; runId?: string }): LocatedInput<TestInput> =>
  // CAST: the helpers read only transportMessageId and runId off the meta.
  ({ meta, inputs: [{ kind: 'user-message' }] }) as unknown as LocatedInput<TestInput>;

/**
 * A body that does its work synchronously. The helpers await the body, so a
 * body with nothing to await is the common test shape.
 * @param fn - What the body does with its context.
 * @returns The body.
 */
const sync =
  <C, T>(fn: (ctx: C) => T) =>
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- the body under test has nothing to await
  (ctx: C): Promise<T> =>
    Promise.resolve(fn(ctx));

/** A body that does nothing. */
const noop = sync((): void => {
  /* nothing to do */
});

/**
 * A body that fails.
 * @param error - What it fails with.
 * @returns The body.
 */
const rejecting =
  (error: Error) =>
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- the body under test only rejects
  (): Promise<never> =>
    Promise.reject(error);

let transport: StubTransport;
let runHandle: StubRunHandle;
let step: StubStep;
let client: { close: ReturnType<typeof vi.fn>; channels: { get: ReturnType<typeof vi.fn> } };
let createClient: ReturnType<typeof vi.fn>;
/** Every lifecycle call in the order it happened, so teardown order is assertable. */
let order: string[];

/**
 * Build the helpers under test, wired to the stubs.
 * @param opts - Optional configuration forwarded to the factory.
 * @returns The three helpers.
 */
const helpers = (
  opts?: Partial<Omit<ActivityHelpersOptions<TestInput, TestOutput>, 'codec' | 'createClient'>>,
): ReturnType<typeof createActivityHelpers<TestInput, TestOutput>> =>
  createActivityHelpers({
    codec,
    // CAST: the client is only asked for a channel, which the mocked transport ignores.
    createClient: createClient as unknown as () => Ably.Realtime,
    ...opts,
  });

/**
 * The hooks the transport received on its most recent open or adopt.
 * @returns The hooks object, or undefined when none was passed.
 */
const receivedHooks = (): OpenRunHooks<TestOutput> | undefined =>
  transport.adoptRun.mock.calls[0]?.[2] ?? transport.openRun.mock.calls[0]?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  step = {
    stepId: ACTIVITY_ID,
    ended: false,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    end: vi.fn(() => {
      order.push('step.end');
      step.ended = true;
      return Promise.resolve();
    }),
  };
  runHandle = {
    runId: 'run-1',
    opened: Promise.resolve(),
    createStep: vi.fn(() => step),
    // Ending the run auto-closes its open step, as the core does.
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    end: vi.fn(() => {
      order.push('run.end');
      step.ended = true;
      return Promise.resolve();
    }),
  };
  transport = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    connect: vi.fn(() => {
      order.push('connect');
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      order.push('transport.close');
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    locateInput: vi.fn(() => Promise.resolve(located({ transportMessageId: 'cm-1' }))),
    openRun: vi.fn((opts?: OpenRunOptions) => {
      // Mirror the transport's precedence: the located input's continuation
      // id, else the caller's pin, else minted. `opened` is already resolved,
      // standing in for an acknowledged opening publish.
      runHandle.runId = opts?.input?.meta.runId ?? opts?.runId ?? 'minted';
      return runHandle;
    }),
    adoptRun: vi.fn((runId: string) => {
      runHandle.runId = runId;
      return runHandle;
    }),
  };
  client = {
    close: vi.fn(() => {
      order.push('client.close');
    }),
    channels: { get: vi.fn(() => ({ name: invocation.channelName })) },
  };
  createClient = vi.fn(() => client);
  mockCancellationSignal = new AbortController().signal;
  mockHeartbeatTimeoutMs = 30_000;
  // CAST: the stub implements only what the helpers call.
  vi.mocked(createAgentTransport).mockImplementation(
    () => transport as unknown as ReturnType<typeof createAgentTransport>,
  );
});

describe('withAgentTransport', () => {
  it('connects, runs the body, then closes the transport before the client', async () => {
    const result = await helpers().withAgentTransport(
      invocation,
      sync(() => {
        order.push('body');
        return 'done';
      }),
    );

    expect(result).toBe('done');
    expect(order).toEqual(['connect', 'body', 'transport.close', 'client.close']);
  });

  it('closes the transport and the client when the body throws, and rethrows', async () => {
    await expect(helpers().withAgentTransport(invocation, rejecting(new Error('body failed')))).rejects.toThrow(
      'body failed',
    );

    expect(order).toEqual(['connect', 'transport.close', 'client.close']);
  });

  it("resolves the channel with the codec's agent param and passes the logger and page size to the transport", async () => {
    const child = { withContext: vi.fn(), trace: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = { withContext: vi.fn(() => child) };

    // CAST: the logger stub implements only what the helpers call.
    await helpers({ logger: logger as never, historyPageSize: 25 }).withAgentTransport(invocation, noop);

    const agentParam: unknown = expect.stringContaining('test/');
    expect(client.channels.get).toHaveBeenCalledWith('ai:room-7', { params: { agent: agentParam } });
    expect(createAgentTransport).toHaveBeenCalledWith(
      expect.objectContaining({ codec, logger: child, historyPageSize: 25 }),
    );
  });

  it('hands the body the parsed invocation and the transport', async () => {
    const seen = await helpers().withAgentTransport(
      invocation,
      sync((ctx) => ctx),
    );

    expect(seen.invocation).toBeInstanceOf(Invocation);
    expect(seen.invocation.channelName).toBe('ai:room-7');
    // CAST: the stub stands in for the transport, so identity is the check.
    expect(seen.transport).toBe(transport as unknown as typeof seen.transport);
  });

  it('rejects with InvalidArgument and builds no client when the invocation is malformed', async () => {
    await expect(
      helpers().withAgentTransport({ inputEventId: 'evt-1', channelName: '' }, noop),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);

    expect(createClient).not.toHaveBeenCalled();
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('beats while the body runs', async () => {
      const { promise: gate, resolve: release } = Promise.withResolvers<string>();
      const running = helpers().withAgentTransport(invocation, async () => gate);
      // Let the connect settle so the pump is running.
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockHeartbeat).toHaveBeenCalledTimes(2);

      release('released');
      await running;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('starts no pump when heartbeat is off', async () => {
      await helpers({ heartbeat: false }).withAgentTransport(invocation, async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(mockHeartbeat).not.toHaveBeenCalled();
    });

    it('starts no pump when the activity has no heartbeat timeout', async () => {
      mockHeartbeatTimeoutMs = undefined;

      await helpers().withAgentTransport(invocation, async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(mockHeartbeat).not.toHaveBeenCalled();
    });
  });
});

describe('withRun', () => {
  describe('adopting', () => {
    it("adopts the run named by ids under its invocation id with the activity's cancellation signal", async () => {
      await helpers().withRun({ ids, invocation }, noop);

      expect(transport.adoptRun).toHaveBeenCalledWith('run-1', { invocationId: 'wf-1' }, expect.anything());
      expect(receivedHooks()?.signal).toBe(mockCancellationSignal);
    });

    it('hands the body the run, its identity, the transport and the invocation', async () => {
      const seen = await helpers().withRun(
        { ids, invocation },
        sync((ctx) => ctx),
      );

      expect(seen.run.runId).toBe('run-1');
      expect(seen.ids).toEqual(ids);
      expect(seen.invocation).toBeInstanceOf(Invocation);
      expect(seen.transport).toBeDefined();
    });

    it('adopts with no signal when cancellable is false', async () => {
      await helpers().withRun({ ids, invocation }, { cancellable: false }, noop);

      expect(receivedHooks()).not.toHaveProperty('signal');
    });

    it('passes onCancel and onSteer through to adoptRun', async () => {
      const onCancel = vi.fn();
      const onSteer = vi.fn();

      await helpers().withRun({ ids, invocation }, { onCancel, onSteer }, noop);

      expect(receivedHooks()).toEqual(expect.objectContaining({ onCancel, onSteer }));
    });

    it('neither locates nor opens', async () => {
      await helpers().withRun({ ids, invocation }, noop);

      expect(transport.locateInput).not.toHaveBeenCalled();
      expect(transport.openRun).not.toHaveBeenCalled();
    });
  });

  describe('opening', () => {
    const open = { invocation, invocationId: 'wf-1' };

    it('locates the trigger, opens a run pinned to the invocation id, and hands the body its identity', async () => {
      const seen = await helpers().withRun(
        open,
        sync(({ ids: opened }) => opened),
      );

      expect(transport.locateInput).toHaveBeenCalledWith('evt-1', expect.anything());
      expect(transport.openRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'wf-1',
          invocationId: 'wf-1',
          input: located({ transportMessageId: 'cm-1' }),
        }),
        expect.objectContaining({ signal: mockCancellationSignal }),
      );
      expect(seen).toEqual({ runId: 'wf-1', invocationId: 'wf-1' });
    });

    it('re-enters the run a continuation trigger names', async () => {
      transport.locateInput.mockResolvedValue(located({ transportMessageId: 'cm-1', runId: 'run-existing' }));

      const seen = await helpers().withRun(
        { invocation, invocationId: 'wf-2' },
        sync(({ ids: opened }) => opened),
      );

      expect(seen).toEqual({ runId: 'run-existing', invocationId: 'wf-2' });
    });

    it('throws NotFound before opening when the trigger is not in history', async () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- the miss IS the undefined resolution
      transport.locateInput.mockResolvedValue(undefined);
      const body = vi.fn(noop);

      await expect(helpers().withRun(open, body)).rejects.toBeErrorInfoWithCode(ErrorCode.NotFound);
      expect(transport.openRun).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
    });

    it('rejects with OperationCancelled before opening when the activity is already cancelled', async () => {
      mockCancellationSignal = AbortSignal.abort();

      await expect(helpers().withRun(open, noop)).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      expect(transport.openRun).not.toHaveBeenCalled();
    });

    it('opens an already-cancelled activity anyway when cancellable is false', async () => {
      // With no signal handed to the transport there is nothing to check, so
      // the open proceeds. The plugin never does this; it documents the knob.
      mockCancellationSignal = AbortSignal.abort();

      await helpers().withRun(open, { cancellable: false }, noop);

      expect(transport.openRun).toHaveBeenCalledTimes(1);
      expect(receivedHooks()).not.toHaveProperty('signal');
    });

    it('rejects without running the body when the opening publish is refused', async () => {
      const failure = new Ably.ErrorInfo('publish refused', 50_000, 500);
      transport.openRun.mockImplementationOnce(() => {
        runHandle.opened = Promise.reject(failure);
        // .catch(): pre-handled, matching the transport's own guarantee, so the
        // stub cannot surface an unhandled rejection of its own.
        runHandle.opened.catch(() => {
          /* observed at the helper's await */
        });
        return runHandle;
      });
      const body = vi.fn(noop);

      await expect(helpers().withRun(open, body)).rejects.toBeErrorInfo({ message: 'publish refused' });
      expect(body).not.toHaveBeenCalled();
    });

    it('bounds the locate scan on maxHistoryPages alone, using the default page size', async () => {
      await helpers({ maxHistoryPages: 5 }).withRun(open, noop);

      expect(transport.locateInput).toHaveBeenCalledWith('evt-1', expect.objectContaining({ limit: 500 }));
    });

    it('bounds the locate scan when both page options are set', async () => {
      await helpers({ maxHistoryPages: 3, historyPageSize: 50 }).withRun(open, noop);

      expect(transport.locateInput).toHaveBeenCalledWith('evt-1', expect.objectContaining({ limit: 150 }));
    });

    it('passes a beating page hook to the scan by default', async () => {
      await helpers().withRun(open, noop);

      const [, scanOpts] = transport.locateInput.mock.calls[0] ?? [];
      expect(scanOpts?.onPage).toBeTypeOf('function');
      scanOpts?.onPage?.();
      expect(mockHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('passes no page hook when heartbeat is off', async () => {
      await helpers({ heartbeat: false }).withRun(open, noop);

      const [, scanOpts] = transport.locateInput.mock.calls[0] ?? [];
      expect(scanOpts?.onPage).toBeUndefined();
    });

    it('passes onSteer through to openRun', async () => {
      const onSteer = vi.fn();

      await helpers().withRun(open, { onSteer }, noop);

      expect(receivedHooks()).toEqual(expect.objectContaining({ onSteer, signal: mockCancellationSignal }));
    });
  });
});

describe('withStep', () => {
  it('adopts the run and creates one step keyed on the activity id', async () => {
    await helpers().withStep({ ids, invocation }, noop);

    expect(transport.adoptRun).toHaveBeenCalledWith('run-1', { invocationId: 'wf-1' }, expect.anything());
    expect(transport.openRun).not.toHaveBeenCalled();
    expect(runHandle.createStep).toHaveBeenCalledWith({ stepId: ACTIVITY_ID });
  });

  it('hands the body the step alongside the run context', async () => {
    const seen = await helpers().withStep(
      { ids, invocation },
      sync((ctx) => ctx),
    );

    expect(seen.step.stepId).toBe(ACTIVITY_ID);
    expect(seen.run.runId).toBe('run-1');
    expect(seen.ids).toEqual(ids);
    expect(seen.invocation).toBeInstanceOf(Invocation);
  });

  it('ends the step with a derived reason on return and returns the body result', async () => {
    const result = await helpers().withStep(
      { ids, invocation },
      sync(() => 'answer'),
    );

    expect(result).toBe('answer');
    expect(step.end).toHaveBeenCalledTimes(1);
    expect(step.end).toHaveBeenCalledWith();
  });

  it('ends the step failed and rethrows when the body throws', async () => {
    await expect(helpers().withStep({ ids, invocation }, rejecting(new Error('model exploded')))).rejects.toThrow(
      'model exploded',
    );

    expect(step.end).toHaveBeenCalledWith({ reason: 'failed' });
  });

  it('still rethrows the body error when the failed step-end rejects', async () => {
    step.end.mockRejectedValue(new Error('publish failed'));

    await expect(helpers().withStep({ ids, invocation }, rejecting(new Error('model exploded')))).rejects.toThrow(
      'model exploded',
    );
  });

  it('leaves a step alone that the body ended itself', async () => {
    await helpers().withStep({ ids, invocation }, async ({ step: own }) => {
      await own.end({ reason: 'cancelled' });
    });

    expect(step.end).toHaveBeenCalledTimes(1);
    expect(step.end).toHaveBeenCalledWith({ reason: 'cancelled' });
  });

  it('leaves the step alone when the body ended the run, which closed the step', async () => {
    await helpers().withStep({ ids, invocation }, async ({ run }) => {
      await run.end({ reason: 'complete' });
    });

    expect(runHandle.end).toHaveBeenCalledTimes(1);
    expect(step.end).not.toHaveBeenCalled();
  });

  it('does not end the step failed when the body ended it before throwing', async () => {
    await expect(
      helpers().withStep({ ids, invocation }, async ({ step: own }) => {
        await own.end();
        throw new Error('after the step');
      }),
    ).rejects.toThrow('after the step');

    expect(step.end).toHaveBeenCalledTimes(1);
    expect(step.end).toHaveBeenCalledWith();
  });

  it('ends the step before closing the transport', async () => {
    await helpers().withStep(
      { ids, invocation },
      sync(() => {
        order.push('body');
      }),
    );

    expect(order).toEqual(['connect', 'body', 'step.end', 'transport.close', 'client.close']);
  });

  it('never ends the run', async () => {
    await helpers().withStep({ ids, invocation }, noop);

    expect(runHandle.end).not.toHaveBeenCalled();
  });

  it('passes hooks through to the adopt and omits the signal when cancellable is false', async () => {
    const onCancel = vi.fn();

    await helpers().withStep({ ids, invocation }, { onCancel, cancellable: false }, noop);

    expect(receivedHooks()).toEqual(expect.objectContaining({ onCancel }));
    expect(receivedHooks()).not.toHaveProperty('signal');
  });
});
