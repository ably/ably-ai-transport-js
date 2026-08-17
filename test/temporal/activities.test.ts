/**
 * Framing activity unit tests.
 *
 * `withAgentSession` is mocked: it is covered by its own tests, and mocking it
 * leaves exactly what these activities own observable — which run entry point
 * they use, whether they load before publishing, what they publish, and that the
 * leased connection always goes back to the pool.
 *
 * The activities run against a real {@link createSessionScope} over a stub client,
 * rather than a stub scope, so the lease discipline is exercised too. Handing the
 * lease back shows up as `channels.release` for the invocation's channel.
 */

import '../helper/expectations.js';

import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Codec } from '../../src/core/codec/types.js';
import type { InvocationData } from '../../src/core/transport/invocation.js';
import type { RunIdentity } from '../../src/core/transport/types/agent.js';
import { withAgentSession } from '../../src/core/transport/with-agent-session.js';
import { ErrorCode } from '../../src/errors.js';
import { createFramingActivities } from '../../src/temporal/activities.js';
import { createSessionScope } from '../../src/temporal/session-scope.js';
import { createPoolableMockClient, type PoolableMockClient } from '../helper/mock-client.js';

vi.mock('../../src/core/transport/with-agent-session.js', () => ({
  withAgentSession: vi.fn(),
}));

vi.mock('@temporalio/activity', () => ({
  Context: {
    current: vi.fn(() => ({ cancellationSignal: new AbortController().signal, heartbeat: vi.fn() })),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
}
type TestCodec = Codec<{ kind: 'input' }, { type: 'output' }, { messages: TestMessage[] }, TestMessage>;

interface StubRun {
  runId: string;
  invocationId: string;
  located: Promise<void>;
  view: { hasOlder: () => boolean; loadOlder: ReturnType<typeof vi.fn> };
  start: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn<(params: RunEndParamsShape) => Promise<void>>>;
  suspend: ReturnType<typeof vi.fn>;
}

/** The shape of the params the activities pass to `run.end`. */
interface RunEndParamsShape {
  reason: string;
  error?: unknown;
}

interface StubSession {
  createRun: ReturnType<typeof vi.fn>;
  adoptRun: ReturnType<
    typeof vi.fn<(invocation: InvocationData, ids: RunIdentity, runOptions?: { signal?: AbortSignal }) => StubRun>
  >;
  end: ReturnType<typeof vi.fn>;
}

const invocation: InvocationData = { inputEventId: 'evt-1', sessionName: 'ai:room-7' };
const ids: RunIdentity = { runId: 'run-1', invocationId: 'wf-1' };

// CAST: the mocked withAgentSession never reads the codec.
const codec = { adapterTag: 'test' } as unknown as TestCodec;

let run: StubRun;
let session: StubSession;
let client: PoolableMockClient;
let createClient: ReturnType<typeof vi.fn>;

const createStubRun = (): StubRun => ({
  runId: 'run-1',
  invocationId: 'wf-1',
  located: Promise.resolve(),
  view: { hasOlder: () => false, loadOlder: vi.fn() },
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  start: vi.fn(() => Promise.resolve()),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  load: vi.fn(() => Promise.resolve()),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  end: vi.fn<(params: RunEndParamsShape) => Promise<void>>(() => Promise.resolve()),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  suspend: vi.fn(() => Promise.resolve()),
});

/**
 * Build the activities under test, wired to the stubs through a real session
 * scope so the connection lease is exercised.
 * @returns The four framing activities.
 */
const activities = (): ReturnType<typeof createFramingActivities> =>
  createFramingActivities({
    scope: createSessionScope({
      codec,
      // CAST: the client only reaches the pool; the mocked withAgentSession
      // never touches it.
      createClient: createClient as unknown as () => Ably.Realtime,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  run = createStubRun();
  session = {
    createRun: vi.fn(() => run),
    adoptRun: vi.fn<(invocation: InvocationData, ids: RunIdentity, runOptions?: { signal?: AbortSignal }) => StubRun>(
      () => run,
    ),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    end: vi.fn(() => Promise.resolve()),
  };
  client = createPoolableMockClient();
  createClient = vi.fn(() => client.client);
  // Invoke the body with the stub session, mirroring the real helper.
  vi.mocked(withAgentSession).mockImplementation(async (_options, body) =>
    // CAST: the stub implements only what the activities call.
    body({ session, invocation } as unknown as Parameters<typeof body>[0]),
  );
});

describe('openRun', () => {
  it('pins the run id to the invocation id so a retry re-enters the same run', async () => {
    await activities().openRun({ invocation, invocationId: 'wf-1' });

    expect(session.createRun).toHaveBeenCalledWith(
      invocation,
      expect.objectContaining({ invocationId: 'wf-1', runId: 'wf-1' }),
      expect.anything(),
    );
  });

  it('starts the run and returns its identity', async () => {
    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).resolves.toEqual({
      runId: 'run-1',
      invocationId: 'wf-1',
    });

    expect(run.start).toHaveBeenCalledTimes(1);
  });

  it('does not drain history when the trigger is already located', async () => {
    await activities().openRun({ invocation, invocationId: 'wf-1' });

    expect(run.view.loadOlder).not.toHaveBeenCalled();
  });

  it('leases one connection and hands it back', async () => {
    await activities().openRun({ invocation, invocationId: 'wf-1' });

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.releasedChannels).toEqual([invocation.sessionName]);
  });

  it('hands the connection back when the run fails to start', async () => {
    const failure = new Error('start failed');
    run.start.mockRejectedValue(failure);

    await expect(activities().openRun({ invocation, invocationId: 'wf-1' })).rejects.toBe(failure);
    expect(client.releasedChannels).toEqual([invocation.sessionName]);
  });
});

describe('endRun', () => {
  it('loads the run before publishing its terminal', async () => {
    await activities().endRun({ ids, invocation, reason: 'complete' });

    expect(run.load).toHaveBeenCalledTimes(1);
    expect(run.end).toHaveBeenCalledWith({ reason: 'complete' });
    expect(run.load.mock.invocationCallOrder[0]).toBeLessThan(run.end.mock.invocationCallOrder[0] ?? 0);
  });

  it('publishes an ErrorInfo for an error terminal', async () => {
    await activities().endRun({ ids, invocation, reason: 'error', errorMessage: 'inference exploded' });

    const params = run.end.mock.calls[0]?.[0];
    expect(params?.reason).toBe('error');
    expect(params?.error).toBeErrorInfo({ code: ErrorCode.StreamError, message: 'inference exploded' });
  });

  it('adopts with the activity cancellation signal', async () => {
    await activities().endRun({ ids, invocation, reason: 'complete' });

    const runOptions = session.adoptRun.mock.calls[0]?.[2];
    expect(runOptions?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('suspendRun', () => {
  it('loads the run then suspends it', async () => {
    await activities().suspendRun({ ids, invocation });

    expect(run.load).toHaveBeenCalledTimes(1);
    expect(run.suspend).toHaveBeenCalledTimes(1);
  });

  it('propagates the open-step refusal', async () => {
    const failure = new Error('unable to suspend run; end the active step before suspending');
    run.suspend.mockRejectedValue(failure);

    await expect(activities().suspendRun({ ids, invocation })).rejects.toBe(failure);
  });
});

describe('cleanupRun', () => {
  it('publishes nothing when the run is already terminal or suspended', async () => {
    run.load.mockRejectedValue(new Error('run is terminal (read-only)'));

    await expect(activities().cleanupRun({ ids, invocation })).resolves.toBeUndefined();

    expect(run.end).not.toHaveBeenCalled();
    expect(session.end).not.toHaveBeenCalled();
    expect(client.releasedChannels).toEqual([invocation.sessionName]);
  });

  it('ends the run as error when it is still active', async () => {
    await activities().cleanupRun({ ids, invocation, errorMessage: 'workflow died' });

    const params = run.end.mock.calls[0]?.[0];
    expect(params?.reason).toBe('error');
    expect(params?.error).toBeErrorInfo({ code: ErrorCode.StreamError, message: 'workflow died' });
  });

  it('adopts without a cancellation signal so it survives a cancelling workflow', async () => {
    await activities().cleanupRun({ ids, invocation });

    expect(session.adoptRun).toHaveBeenCalledWith(invocation, ids);
  });

  it('falls back to ending the session when the terminal publish fails, then rethrows', async () => {
    const failure = new Error('publish failed');
    run.end.mockRejectedValue(failure);

    await expect(activities().cleanupRun({ ids, invocation })).rejects.toBe(failure);

    expect(session.end).toHaveBeenCalledTimes(1);
    expect(client.releasedChannels).toEqual([invocation.sessionName]);
  });

  it('swallows a failing session end so the original error survives', async () => {
    const failure = new Error('publish failed');
    run.end.mockRejectedValue(failure);
    session.end.mockRejectedValue(new Error('channel gone'));

    await expect(activities().cleanupRun({ ids, invocation })).rejects.toBe(failure);
  });
});
