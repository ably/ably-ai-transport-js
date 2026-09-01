/**
 * Framing activity unit tests.
 *
 * `createAgentTransport` is mocked: the transport is covered by its own tests,
 * and mocking it leaves exactly what these activities own observable — how a
 * run is located and opened, the history fold that gates the terminal
 * activities, what they publish, and that the client and transport they built
 * are always torn down.
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

vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => ({ cancellationSignal: mockCancellationSignal, heartbeat: vi.fn() }),
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

const invocation: InvocationData = { inputEventId: 'evt-1', sessionName: 'ai:room-7' };
const ids: RunIdentity = { runId: 'run-1', invocationId: 'wf-1' };

// CAST: the mocked transport never reads the codec.
const codec = { adapterTag: 'test' } as unknown as WireCodec<TestInput, TestOutput>;

interface StubRunHandle {
  runId: string;
  opened: Promise<void>;
  end: ReturnType<typeof vi.fn<(params: { reason: string; error?: unknown }) => Promise<void>>>;
  suspend: ReturnType<typeof vi.fn>;
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
 * A run-lifecycle history event.
 * @param type - The lifecycle type.
 * @param runId - The run's id.
 * @returns The event.
 */
const lifecycle = (type: 'start' | 'suspend' | 'resume' | 'end', runId: string): Event =>
  ({
    kind: 'run-lifecycle',
    // CAST: only kind/runId/type are read by the fold under test.
    event: { type, runId, clientId: '', invocationId: '', serial: `s-${type}` },
  }) as Event;

/**
 * A located trigger with the given wire identity.
 * @param meta - The identity fields the activities read.
 * @param meta.codecMessageId - The trigger's codec-message-id.
 * @param meta.runId - The run-id header, set on a continuation trigger.
 * @returns The located input.
 */
const located = (meta: { codecMessageId?: string; runId?: string }): LocatedInput<TestInput> =>
  // CAST: the activities read only codecMessageId and runId off the meta.
  ({ meta, inputs: [{ kind: 'user-message' }] }) as unknown as LocatedInput<TestInput>;

let transport: StubTransport;
let runHandle: StubRunHandle;
let client: { close: ReturnType<typeof vi.fn>; channels: { get: ReturnType<typeof vi.fn> } };
let createClient: ReturnType<typeof vi.fn>;

/**
 * Build the activities under test, wired to the stubs.
 * @param opts - Optional configuration forwarded to the factory.
 * @param opts.maxHistoryPages - Page bound for the history scans.
 * @param opts.historyPageSize - Wire-message limit per page.
 * @returns The four framing activities.
 */
const activities = (opts?: {
  maxHistoryPages?: number;
  historyPageSize?: number;
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
  runHandle = {
    runId: 'run-1',
    opened: Promise.resolve(),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    end: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    suspend: vi.fn(() => Promise.resolve()),
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
    locateInput: vi.fn(() => Promise.resolve(located({ codecMessageId: 'cm-1' }))),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    history: vi.fn(() => Promise.resolve({ events: [lifecycle('start', 'run-1')], exhausted: true })),
    openRun: vi.fn((opts?: OpenRunOptions) => {
      // Mirror the transport's precedence: the located input's continuation
      // id, else the caller's pin, else minted; the input decides the echo type.
      const triggerRunId = opts?.input?.meta.runId;
      runHandle.runId = triggerRunId ?? opts?.runId ?? 'minted';
      // A published open echoes back on the receive stream.
      queueMicrotask(() => {
        const type = triggerRunId === undefined ? 'start' : 'resume';
        for (const handler of handlers) handler(lifecycle(type, runHandle.runId));
      });
      return runHandle;
    }),
    adoptRun: vi.fn((runId: string) => {
      runHandle.runId = runId;
      return runHandle;
    }),
  };
  client = { close: vi.fn(), channels: { get: vi.fn(() => ({ name: invocation.sessionName })) } };
  createClient = vi.fn(() => client);
  // A live (un-aborted) signal, restoring the default for any test that
  // swapped in an already-aborted one.
  mockCancellationSignal = new AbortController().signal;
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
        input: located({ codecMessageId: 'cm-1' }),
      }),
      expect.anything(),
    );
    expect(result).toEqual({ runId: 'wf-1', invocationId: 'wf-1' });
  });

  it('rejects fast when the opening publish fails', async () => {
    const failure = new Ably.ErrorInfo('publish refused', 50000, 500);
    transport.openRun.mockImplementationOnce(() => {
      // A failed opening publish: `opened` rejects and no echo ever arrives.
      runHandle.opened = Promise.reject(failure);
      // .catch(): pre-handled, matching the transport's own guarantee, so the
      // stub cannot surface an unhandled rejection of its own.
      runHandle.opened.catch(() => {
        /* observed via the activity's race */
      });
      return runHandle;
    });

    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).rejects.toBeErrorInfo({
      message: 'publish refused',
    });
  });

  it('rejects fast when the activity is already cancelled', async () => {
    // An already-aborted signal never fires `abort`, so the open-echo wait
    // must check it up front rather than waiting for an event that cannot come.
    mockCancellationSignal = AbortSignal.abort();

    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.OperationCancelled,
    );
  });

  it('re-enters the run a continuation trigger names', async () => {
    transport.locateInput.mockResolvedValue(located({ codecMessageId: 'cm-1', runId: 'run-existing' }));

    const result = await activities().openRun({ invocation, invocationId: 'wf-2' });

    expect(transport.openRun).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'wf-2',
        input: located({ codecMessageId: 'cm-1', runId: 'run-existing' }),
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

  it('ends a run the wire already shows as suspended', async () => {
    transport.history.mockResolvedValue({ events: [lifecycle('suspend', 'run-1')], exhausted: true });

    // No gate: the activity publishes regardless of what the wire holds.
    await activities().endRun({ ids, invocation, reason: 'complete' });

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

describe('suspendRun', () => {
  it('adopts the run and suspends it', async () => {
    await activities().suspendRun({ ids, invocation });

    expect(transport.adoptRun).toHaveBeenCalledWith('run-1', { invocationId: 'wf-1' }, expect.anything());
    expect(runHandle.suspend).toHaveBeenCalledTimes(1);
  });

  it('reads no history: the suspend publishes unconditionally', async () => {
    transport.history.mockResolvedValue({ events: [lifecycle('end', 'run-1')], exhausted: true });

    await activities().suspendRun({ ids, invocation });

    expect(transport.history).not.toHaveBeenCalled();
    expect(runHandle.suspend).toHaveBeenCalledTimes(1);
  });
});

describe('cleanupRun', () => {
  it('ends the run as error with the failure message', async () => {
    await activities().cleanupRun({ ids, invocation, errorMessage: 'workflow blew up' });

    expect(transport.adoptRun).toHaveBeenCalledWith('run-1', { invocationId: 'wf-1' });
    const wrapped: unknown = expect.objectContaining({ message: 'workflow blew up' });
    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'error', error: wrapped });
  });

  it.each([
    ['suspended', lifecycle('suspend', 'run-1')],
    ['ended', lifecycle('end', 'run-1')],
  ])('publishes its error terminal even for a %s run', async (_desc, event) => {
    transport.history.mockResolvedValue({ events: [event], exhausted: true });

    // The cleanup arm reads no history. For an already-ended run this adds a
    // second `ai-run-end` that readers ignore in favour of the first.
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
