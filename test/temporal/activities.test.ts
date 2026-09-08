/**
 * Framing activity unit tests.
 *
 * `createAgentTransport` is mocked: the transport is covered by its own tests,
 * and mocking it leaves exactly what these activities own observable — how a
 * run is located and opened, that the terminal activities publish
 * unconditionally without reading the wire, what they publish, and that the
 * client and transport they built are always torn down.
 */

import '../helper/expectations.js';

import * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WireCodec } from '../../src/core/codec/types.js';
import { createAgentTransport } from '../../src/core/transport/agent-transport.js';
import type { InvocationData } from '../../src/core/transport/invocation.js';
import type {
  AdoptRunOptions,
  LocatedInput,
  OpenRunHooks,
  OpenRunOptions,
  RunIdentity,
  TransportEvent,
  TransportHistoryOptions,
  TransportHistoryResult,
} from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { createFramingActivities } from '../../src/temporal/activities.js';

vi.mock('../../src/core/transport/agent-transport.js', () => ({
  createAgentTransport: vi.fn(),
}));

/** The activity cancellation signal the Context stub hands out; reset per test. */
let mockCancellationSignal: AbortSignal = new AbortController().signal;

/** The heartbeat spy every stubbed activity Context hands out. */
const mockHeartbeat = vi.fn();
/** The activity's heartbeat timeout; undefined models an activity with none. */
let mockHeartbeatTimeoutMs: number | undefined = 30_000;

vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => ({
      cancellationSignal: mockCancellationSignal,
      heartbeat: mockHeartbeat,
      info: { heartbeatTimeoutMs: mockHeartbeatTimeoutMs },
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
type Event = TransportEvent<TestInput, TestOutput>;

const invocation: InvocationData = { inputEventId: 'evt-1', channelName: 'ai:room-7' };
const ids: RunIdentity = { runId: 'run-1', invocationId: 'wf-1' };

// CAST: the mocked transport never reads the codec.
const codec = { adapterTag: 'test' } as unknown as WireCodec<TestInput, TestOutput>;

interface StubRunHandle {
  runId: string;
  opened: Promise<void>;
  end: ReturnType<typeof vi.fn<(params: { reason: string; error?: unknown }) => Promise<void>>>;
}

interface StubTransport {
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  subscribe: (handler: (event: Event) => void) => () => void;
  locateInput: ReturnType<typeof vi.fn<(eventId: string, opts?: TransportHistoryOptions) => Promise<unknown>>>;
  history: ReturnType<
    typeof vi.fn<(opts?: TransportHistoryOptions) => Promise<TransportHistoryResult<TestInput, TestOutput>>>
  >;
  openRun: ReturnType<typeof vi.fn<(opts?: OpenRunOptions, hooks?: OpenRunHooks<TestOutput>) => StubRunHandle>>;
  adoptRun: ReturnType<
    typeof vi.fn<(runId: string, opts?: AdoptRunOptions, hooks?: OpenRunHooks<TestOutput>) => StubRunHandle>
  >;
}

/**
 * A run-lifecycle event, used as the open echo and as history-stub content.
 * @param type - The lifecycle type.
 * @param runId - The run's id.
 * @returns The event.
 */
const lifecycle = (type: 'start' | 'suspend' | 'end', runId: string): Event =>
  ({
    kind: 'run-lifecycle',
    // CAST: only kind/runId/type are read by the open-echo wait.
    event: { type, runId, clientId: '', invocationId: '', serial: `s-${type}` },
  }) as Event;

/**
 * A located trigger with the given wire identity.
 * @param meta - The identity fields the activities read.
 * @param meta.transportMessageId - The trigger's transport-message-id.
 * @param meta.runId - The run-id header, set on a continuation trigger.
 * @returns The located input.
 */
const located = (meta: { transportMessageId?: string; runId?: string }): LocatedInput<TestInput> =>
  // CAST: the activities read only transportMessageId and runId off the meta.
  ({ meta, inputs: [{ kind: 'user-message' }] }) as unknown as LocatedInput<TestInput>;

let transport: StubTransport;
let runHandle: StubRunHandle;
/** Receive-stream handlers the activity registered; it should register none. */
let subscribedHandlers: Set<(event: Event) => void>;

/**
 * Run an open and return the page hook it handed the locate scan.
 * @param opts - Factory options for the activities under test.
 * @param opts.heartbeat - Whether to ask for heartbeating; omit for the default.
 * @returns The `onPage` hook, or undefined when none was passed.
 */
const pageHookFrom = async (opts?: { heartbeat?: boolean }): Promise<(() => void) | undefined> => {
  await activities(opts).openRun({ invocation, invocationId: 'wf-1' });
  const [, scanOpts] = transport.locateInput.mock.calls[0] ?? [];
  return scanOpts?.onPage;
};
let client: { close: ReturnType<typeof vi.fn>; channels: { get: ReturnType<typeof vi.fn> } };
let createClient: ReturnType<typeof vi.fn>;

/**
 * Build the activities under test, wired to the stubs.
 * @param opts - Optional configuration forwarded to the factory.
 * @param opts.maxHistoryPages - Page bound for the history scans.
 * @param opts.historyPageSize - Wire-message limit per page.
 * @param opts.heartbeat - Whether to ask for heartbeating; omit for the default.
 * @returns The three framing activities.
 */
const activities = (opts?: {
  maxHistoryPages?: number;
  historyPageSize?: number;
  heartbeat?: boolean;
}): ReturnType<typeof createFramingActivities> =>
  createFramingActivities({
    codec,
    // CAST: the client is only asked for a channel, which the mocked transport ignores.
    createClient: createClient as unknown as () => Ably.Realtime,
    ...opts,
  });

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Set<(event: Event) => void>();
  subscribedHandlers = handlers;
  runHandle = {
    runId: 'run-1',
    opened: Promise.resolve(),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    end: vi.fn(() => Promise.resolve()),
  };
  transport = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    connect: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    locateInput: vi.fn(() => Promise.resolve(located({ transportMessageId: 'cm-1' }))),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    history: vi.fn(() => Promise.resolve({ events: [lifecycle('start', 'run-1')], exhausted: true })),
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
  client = { close: vi.fn(), channels: { get: vi.fn(() => ({ name: invocation.channelName })) } };
  createClient = vi.fn(() => client);
  // A live (un-aborted) signal, restoring the default for any test that
  // swapped in an already-aborted one.
  mockCancellationSignal = new AbortController().signal;
  mockHeartbeatTimeoutMs = 30_000;
  // CAST: the stub implements only what the activities call.
  vi.mocked(createAgentTransport).mockImplementation(
    () => transport as unknown as ReturnType<typeof createAgentTransport>,
  );
});

describe('openRun', () => {
  it('locates the trigger, opens a fresh run pinned to the invocation id, and returns its identity', async () => {
    const result = await activities().openRun({ invocation, invocationId: 'wf-1' });

    expect(transport.locateInput).toHaveBeenCalledWith('evt-1', expect.anything());
    expect(transport.openRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'wf-1',
        invocationId: 'wf-1',
        input: located({ transportMessageId: 'cm-1' }),
      }),
      expect.anything(),
    );
    expect(result).toEqual({ runId: 'wf-1', invocationId: 'wf-1' });
  });

  it('rejects fast when the opening publish is refused', async () => {
    const failure = new Ably.ErrorInfo('publish refused', 50000, 500);
    transport.openRun.mockImplementationOnce(() => {
      runHandle.opened = Promise.reject(failure);
      // .catch(): pre-handled, matching the transport's own guarantee, so the
      // stub cannot surface an unhandled rejection of its own.
      runHandle.opened.catch(() => {
        /* observed at the activity's await */
      });
      return runHandle;
    });

    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).rejects.toBeErrorInfo({
      message: 'publish refused',
    });
  });

  it('confirms the open from the publish acknowledgement, not from an echo', async () => {
    // The stub delivers no opening echo and the activity still completes, so
    // a client running with `echoMessages: false` opens a run fine. It also
    // registers no receive handler, which is what makes the echo irrelevant
    // rather than merely unused. The refusal case above covers the await
    // itself: a rejected `opened` fails the activity.
    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).resolves.toEqual({
      runId: 'wf-1',
      invocationId: 'wf-1',
    });
    expect(subscribedHandlers.size).toBe(0);
  });

  it('rejects without opening when the activity is already cancelled', async () => {
    // The opening publish is not abortable, so a cancelled activity must fail
    // before it puts an opening event on the channel.
    mockCancellationSignal = AbortSignal.abort();

    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.OperationCancelled,
    );
    expect(transport.openRun).not.toHaveBeenCalled();
  });

  it('re-enters the run a continuation trigger names', async () => {
    transport.locateInput.mockResolvedValue(located({ transportMessageId: 'cm-1', runId: 'run-existing' }));

    const result = await activities().openRun({ invocation, invocationId: 'wf-2' });

    expect(transport.openRun).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'wf-2',
        input: located({ transportMessageId: 'cm-1', runId: 'run-existing' }),
      }),
      expect.anything(),
    );
    expect(result).toEqual({ runId: 'run-existing', invocationId: 'wf-2' });
  });

  it('throws NotFound before publishing when the trigger is not in history', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- the miss IS the undefined resolution
    transport.locateInput.mockResolvedValue(undefined);

    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.NotFound,
    );
    expect(transport.openRun).not.toHaveBeenCalled();
  });

  it('bounds the locate scan on maxHistoryPages alone, using the default page size', async () => {
    // `historyPageSize` has a transport-side default, so a caller who names
    // only the bound still gets one.
    await activities({ maxHistoryPages: 5 }).openRun({ invocation, invocationId: 'wf-1' });

    expect(transport.locateInput).toHaveBeenCalledWith('evt-1', expect.objectContaining({ limit: 500 }));
  });

  it('bounds the locate scan when both page options are set', async () => {
    await activities({ maxHistoryPages: 3, historyPageSize: 50 }).openRun({ invocation, invocationId: 'wf-1' });

    expect(transport.locateInput).toHaveBeenCalledWith('evt-1', expect.objectContaining({ limit: 150 }));
  });

  it('closes the transport and the client even when the open fails', async () => {
    transport.locateInput.mockRejectedValue(new Error('history unavailable'));

    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).rejects.toThrow('history unavailable');
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  describe('the history scan page hook', () => {
    it('is passed by default, and reports progress when the activity has a heartbeat timeout', async () => {
      const onPage = await pageHookFrom();

      expect(onPage).toBeTypeOf('function');
      onPage?.();
      expect(mockHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('stays silent when the activity has no heartbeat timeout', async () => {
      // Temporal's contract: an activity must not heartbeat when no
      // heartbeatTimeout is defined, whatever the SDK option asked for.
      mockHeartbeatTimeoutMs = undefined;

      const onPage = await pageHookFrom();

      onPage?.();
      expect(mockHeartbeat).not.toHaveBeenCalled();
    });

    it('is not passed at all when heartbeating is turned off', async () => {
      const onPage = await pageHookFrom({ heartbeat: false });

      expect(onPage).toBeUndefined();
    });
  });
});

describe('endRun', () => {
  it('adopts the run and ends it with the reason', async () => {
    await activities().endRun({ ids, invocation, reason: 'complete' });

    expect(transport.adoptRun).toHaveBeenCalledWith('run-1', { invocationId: 'wf-1' }, expect.anything());
    expect(transport.openRun).not.toHaveBeenCalled();
    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'complete' });
  });

  it('reads no history: the terminal publishes unconditionally', async () => {
    await activities().endRun({ ids, invocation, reason: 'complete' });

    expect(transport.history).not.toHaveBeenCalled();
  });

  it('wraps the error message when the reason is error', async () => {
    await activities().endRun({ ids, invocation, reason: 'error', errorMessage: 'model exploded' });

    const wrapped: unknown = expect.objectContaining({
      message: 'model exploded',
      code: ErrorCode.RunResponseStreamFailed,
    });
    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'error', error: wrapped });
  });

  it('ends a run the application parked, without reading the wire first', async () => {
    // The plugin parks no run, but an app activity holding the core run handle
    // can, so this state is still reachable on a shared channel.
    transport.history.mockResolvedValue({ events: [lifecycle('suspend', 'run-1')], exhausted: true });

    await activities().endRun({ ids, invocation, reason: 'complete' });

    expect(transport.history).not.toHaveBeenCalled();
    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'complete' });
  });

  it('ends a run the wire already shows as ended, leaving a duplicate terminal', async () => {
    transport.history.mockResolvedValue({ events: [lifecycle('end', 'run-1')], exhausted: true });

    // A retry of a publish-then-crashed attempt puts a second `ai-run-end` on
    // the channel. Readers absorb it by respecting the first terminal in
    // serial order, so the activity does not need to check first.
    await activities().endRun({ ids, invocation, reason: 'complete' });

    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'complete' });
  });
});

describe('cleanupRun', () => {
  it('ends the run as error with the failure message', async () => {
    await activities().cleanupRun({ ids, invocation, errorMessage: 'workflow blew up' });

    // The cleanup arm adopts without Temporal's cancellation signal, so it
    // still runs while the workflow itself is being cancelled.
    expect(transport.adoptRun).toHaveBeenCalledWith('run-1', { invocationId: 'wf-1' }, expect.anything());
    expect(transport.adoptRun.mock.calls[0]?.[2]).not.toHaveProperty('signal');
    const wrapped: unknown = expect.objectContaining({ message: 'workflow blew up' });
    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'error', error: wrapped });
  });

  it('publishes its error terminal even for an already-ended run', async () => {
    transport.history.mockResolvedValue({ events: [lifecycle('end', 'run-1')], exhausted: true });

    // The cleanup arm reads no history, so this adds a second `ai-run-end`
    // that a reader absorbs by honouring the first.
    await activities().cleanupRun({ ids, invocation });

    const wrapped: unknown = expect.objectContaining({ code: ErrorCode.RunResponseStreamFailed });
    expect(transport.history).not.toHaveBeenCalled();
    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'error', error: wrapped });
  });

  it('always tears down the transport and the client', async () => {
    runHandle.end.mockRejectedValue(new Error('publish failed'));

    await expect(activities().cleanupRun({ ids, invocation })).rejects.toThrow('publish failed');
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
