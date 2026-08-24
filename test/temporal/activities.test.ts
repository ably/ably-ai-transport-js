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

import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WireCodec } from '../../src/core/codec/types.js';
import { createAgentTransport } from '../../src/core/transport/agent-transport.js';
import type { InvocationData } from '../../src/core/transport/invocation.js';
import type {
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

vi.mock('@temporalio/activity', () => ({
  Context: {
    current: vi.fn(() => ({ cancellationSignal: new AbortController().signal, heartbeat: vi.fn() })),
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
  adoptRun: ReturnType<typeof vi.fn<(runId: string, hooks?: OpenRunHooks<TestOutput>) => StubRunHandle>>;
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
  client = { close: vi.fn(), channels: { get: vi.fn(() => ({ name: invocation.channelName })) } };
  createClient = vi.fn(() => client);
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

  it('throws InputEventNotFound before publishing when the trigger is not in history', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- the miss IS the undefined resolution
    transport.locateInput.mockResolvedValue(undefined);

    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.NotFound,
    );
    expect(transport.openRun).not.toHaveBeenCalled();
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
  it('gates on the history fold, adopts without publishing, and ends with the reason', async () => {
    await activities().endRun({ ids, invocation, reason: 'complete' });

    expect(transport.adoptRun).toHaveBeenCalledWith('run-1', expect.anything());
    expect(transport.openRun).not.toHaveBeenCalled();
    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'complete' });
  });

  it('wraps the error message when the reason is error', async () => {
    await activities().endRun({ ids, invocation, reason: 'error', errorMessage: 'model exploded' });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher for the wrapped error
    const wrapped: unknown = expect.objectContaining({
      message: 'model exploded',
      code: ErrorCode.RunResponseStreamFailed,
    });
    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'error', error: wrapped });
  });

  it('rejects a suspended run without publishing', async () => {
    transport.history.mockResolvedValue({ events: [lifecycle('suspend', 'run-1')], exhausted: true });

    await expect(activities().endRun({ ids, invocation, reason: 'complete' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );
    expect(transport.adoptRun).not.toHaveBeenCalled();
  });

  it('rejects an already-ended run without publishing', async () => {
    transport.history.mockResolvedValue({ events: [lifecycle('end', 'run-1')], exhausted: true });

    await expect(activities().endRun({ ids, invocation, reason: 'complete' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );
    expect(transport.adoptRun).not.toHaveBeenCalled();
  });

  it('rejects retryably when the run is not found in the pages read', async () => {
    transport.history.mockResolvedValue({ events: [], exhausted: true });

    await expect(activities().endRun({ ids, invocation, reason: 'complete' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.NotFound,
    );
  });

  it('reads the latest lifecycle state, not the first', async () => {
    // The run started, suspended, and resumed: the latest state is open.
    transport.history.mockResolvedValue({
      events: [lifecycle('start', 'run-1'), lifecycle('suspend', 'run-1'), lifecycle('resume', 'run-1')],
      exhausted: true,
    });

    await activities().endRun({ ids, invocation, reason: 'complete' });

    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'complete' });
  });

  it('pages older history until the run is found', async () => {
    transport.history
      .mockResolvedValueOnce({ events: [lifecycle('start', 'run-other')], exhausted: false })
      .mockResolvedValueOnce({ events: [lifecycle('start', 'run-1')], exhausted: false });

    await activities().endRun({ ids, invocation, reason: 'complete' });

    expect(transport.history).toHaveBeenCalledTimes(2);
    expect(runHandle.end).toHaveBeenCalled();
  });

  it('gives up at the page bound and rejects retryably', async () => {
    transport.history.mockResolvedValue({ events: [], exhausted: false });

    await expect(
      activities({ maxHistoryPages: 2 }).endRun({ ids, invocation, reason: 'complete' }),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.NotFound);
    expect(transport.history).toHaveBeenCalledTimes(2);
  });
});

describe('suspendRun', () => {
  it('gates on the history fold, adopts without publishing, and suspends', async () => {
    await activities().suspendRun({ ids, invocation });

    expect(transport.adoptRun).toHaveBeenCalledWith('run-1', expect.anything());
    expect(runHandle.suspend).toHaveBeenCalledTimes(1);
  });

  it('rejects a run that is already suspended', async () => {
    transport.history.mockResolvedValue({ events: [lifecycle('suspend', 'run-1')], exhausted: true });

    await expect(activities().suspendRun({ ids, invocation })).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });
});

describe('cleanupRun', () => {
  it('ends a still-open run as error with the failure message', async () => {
    await activities().cleanupRun({ ids, invocation, errorMessage: 'workflow blew up' });

    expect(transport.adoptRun).toHaveBeenCalledWith('run-1');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher for the wrapped error
    const wrapped: unknown = expect.objectContaining({ message: 'workflow blew up' });
    expect(runHandle.end).toHaveBeenCalledWith({ reason: 'error', error: wrapped });
  });

  it.each([
    ['suspended', lifecycle('suspend', 'run-1')],
    ['ended', lifecycle('end', 'run-1')],
  ])('returns early for a %s run', async (_desc, event) => {
    transport.history.mockResolvedValue({ events: [event], exhausted: true });

    await activities().cleanupRun({ ids, invocation });

    expect(transport.adoptRun).not.toHaveBeenCalled();
    expect(runHandle.end).not.toHaveBeenCalled();
  });

  it('returns early when the run is not found in the pages read', async () => {
    transport.history.mockResolvedValue({ events: [], exhausted: true });

    await activities().cleanupRun({ ids, invocation });

    expect(transport.adoptRun).not.toHaveBeenCalled();
  });

  it('always tears down the transport and the client', async () => {
    runHandle.end.mockRejectedValue(new Error('publish failed'));

    await expect(activities().cleanupRun({ ids, invocation })).rejects.toThrow('publish failed');
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
