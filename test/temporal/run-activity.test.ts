/**
 * Activity scaffold tests.
 *
 * The scaffold writes the preamble each activity needs, so what matters is that
 * it writes the right one: adopt with the activity's cancellation signal, load
 * before the body runs, page history only when asked, and hand the connection back
 * on both paths. One activity is one step, so the scaffold opens and closes it; the
 * two behaviours worth asserting explicitly are that the id is the retry-stable one,
 * and that a throwing body leaves the step open so a retry can supersede it.
 *
 * `withAgentSession` is mocked, as in the framing activity tests, leaving the
 * scaffold's own decisions observable.
 */

import '../helper/expectations.js';

import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { Codec } from '../../src/core/codec/types.js';
import type { InvocationData } from '../../src/core/transport/invocation.js';
import type { RunIdentity } from '../../src/core/transport/types/agent.js';
import { withAgentSession } from '../../src/core/transport/with-agent-session.js';
import { createAblyTransportPlugin } from '../../src/temporal/plugin.js';
import { createPoolableMockClient, type PoolableMockClient } from '../helper/mock-client.js';

vi.mock('../../src/core/transport/with-agent-session.js', () => ({
  withAgentSession: vi.fn(),
}));

vi.mock('@temporalio/activity', () => ({
  Context: {
    current: vi.fn(() => ({
      cancellationSignal: new AbortController().signal,
      heartbeat: vi.fn(),
      info: { activityId: '7', heartbeatTimeoutMs: 10_000 },
    })),
  },
}));

interface TestMessage {
  id: string;
}
type TestCodec = Codec<{ kind: 'input' }, { type: 'output' }, { messages: TestMessage[] }, TestMessage>;
type TestPlugin = ReturnType<
  typeof createAblyTransportPlugin<{ kind: 'input' }, { type: 'output' }, { messages: TestMessage[] }, TestMessage>
>;

/** An activity input carrying a field beyond what the scaffold requires. */
interface ToolStepInput {
  ids: RunIdentity;
  invocation: InvocationData;
  toolName: string;
}

const invocation: InvocationData = { inputEventId: 'evt-1', sessionName: 'ai:room-7' };
const ids: RunIdentity = { runId: 'run-1', invocationId: 'wf-1' };
const input = { ids, invocation };

// CAST: the mocked withAgentSession never reads the codec.
const codec = { adapterTag: 'test' } as unknown as TestCodec;

/**
 * A body that does nothing, for the cases where only the framing is under test.
 * @returns A resolved promise.
 */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- mock body with no awaitable work
const noop = (): Promise<void> => Promise.resolve();

interface StubStep {
  start: Mock<() => Promise<void>>;
  end: Mock<(params?: { reason: string }) => Promise<void>>;
  send: Mock<(output: { type: string }) => Promise<void>>;
}

interface StubRun {
  load: Mock<() => Promise<void>>;
  createStep: Mock<(options: { stepId: string }) => StubStep>;
  view: { hasOlder: Mock<() => boolean>; loadOlder: Mock<() => Promise<unknown[]>> };
}

let step: StubStep;
let run: StubRun;
let session: {
  adoptRun: Mock<(invocation: unknown, ids: RunIdentity, hooks?: { signal?: AbortSignal }) => StubRun>;
};
let client: PoolableMockClient;

/**
 * Build a plugin wired to the stubs.
 * @returns The plugin under test.
 */
const plugin = (): TestPlugin =>
  createAblyTransportPlugin({
    codec,
    // CAST: the client only reaches the pool; the mocked withAgentSession never
    // touches it.
    createClient: (): Ably.Realtime => client.client,
  });

beforeEach(() => {
  vi.clearAllMocks();
  step = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    start: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    end: vi.fn<(params?: { reason: string }) => Promise<void>>(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    send: vi.fn<(output: { type: string }) => Promise<void>>(() => Promise.resolve()),
  };
  run = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    load: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    createStep: vi.fn<(options: { stepId: string }) => StubStep>(() => step),
    view: {
      hasOlder: vi.fn<() => boolean>(() => false),
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      loadOlder: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
    },
  };
  session = {
    adoptRun: vi.fn<(invocation: unknown, ids: RunIdentity, hooks?: { signal?: AbortSignal }) => StubRun>(() => run),
  };
  client = createPoolableMockClient();
  vi.mocked(withAgentSession).mockImplementation(async (_options, body) =>
    // CAST: the stub implements only what the scaffold calls.
    body({ session, invocation } as unknown as Parameters<typeof body>[0]),
  );
});

describe('activity', () => {
  it('adopts the run with the activity cancellation signal, so a workflow cancel reaches the body', async () => {
    const activity = plugin().activity(noop);

    await activity(input);

    expect(session.adoptRun).toHaveBeenCalledWith(invocation, ids, expect.anything());
    const hooks = session.adoptRun.mock.calls[0]?.[2];
    expect(hooks?.signal).toBeInstanceOf(AbortSignal);
  });

  it('loads the run before the body runs', async () => {
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    run.load.mockImplementation(() => {
      order.push('load');
      return Promise.resolve();
    });
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock body with no awaitable work
    const activity = plugin().activity(() => {
      order.push('body');
      return Promise.resolve();
    });

    await activity(input);

    expect(order).toEqual(['load', 'body']);
  });

  it('hands the body the run, the session and the parsed invocation', async () => {
    expect.assertions(3);
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock body with no awaitable work
    const activity = plugin().activity((context) => {
      expect(context.run).toBe(run);
      expect(context.session).toBe(session);
      expect(context.invocation.sessionName).toBe(invocation.sessionName);
      return Promise.resolve();
    });

    await activity(input);
  });

  it('pages no history by default', async () => {
    run.view.hasOlder.mockReturnValue(true);
    const activity = plugin().activity(noop);

    await activity(input);

    expect(run.view.loadOlder).not.toHaveBeenCalled();
  });

  it('drains the whole conversation for history: full', async () => {
    let pages = 2;
    run.view.hasOlder.mockImplementation(() => pages > 0);
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    run.view.loadOlder.mockImplementation(() => {
      pages -= 1;
      return Promise.resolve([{ id: 'm' }]);
    });
    const activity = plugin().activity({ history: 'full' }, noop);

    await activity(input);

    expect(run.view.loadOlder).toHaveBeenCalledTimes(2);
  });

  it('pages history in bulk rather than at the view default of ten', async () => {
    let pages = 1;
    run.view.hasOlder.mockImplementation(() => pages > 0);
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    run.view.loadOlder.mockImplementation(() => {
      pages -= 1;
      return Promise.resolve([{ id: 'm' }]);
    });
    const activity = plugin().activity({ history: 'full' }, noop);

    await activity(input);

    expect(run.view.loadOlder).toHaveBeenCalledWith(100);
  });

  it('stops draining on a page that reveals nothing, so a closed view cannot spin', async () => {
    // `loadOlder` returns an empty array on a closed view while `hasOlder` can
    // still report true, and the await only yields to microtasks.
    run.view.hasOlder.mockReturnValue(true);
    const activity = plugin().activity({ history: 'full' }, noop);

    await activity(input);

    expect(run.view.loadOlder).toHaveBeenCalledTimes(1);
  });

  it('infers the activity input from the body, and returns the body result to the workflow', async () => {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock body with no awaitable work
    const activity = plugin().activity((_context, toolInput: ToolStepInput) =>
      Promise.resolve(`ran ${toolInput.toolName}`),
    );

    await expect(activity({ ids, invocation, toolName: 'getStockPrice' })).resolves.toBe('ran getStockPrice');
  });

  it('hands the connection back on the success path', async () => {
    const activity = plugin().activity(noop);

    await activity(input);

    expect(client.releasedChannels).toEqual([invocation.sessionName]);
  });

  it('hands the connection back when the body throws', async () => {
    const failure = new Error('inference exploded');
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock body with no awaitable work
    const activity = plugin().activity(() => Promise.reject(failure));

    await expect(activity(input)).rejects.toBe(failure);
    expect(client.releasedChannels).toEqual([invocation.sessionName]);
  });
});

describe('the step', () => {
  it('opens a started step under an id a retry re-enters', async () => {
    const activity = plugin().activity(noop);

    await activity(input);

    // The invocation id keeps two workflows' step-1s apart; the activity id makes
    // a retry of this activity reuse the same step and supersede its output.
    expect(run.createStep).toHaveBeenCalledWith({ stepId: 'wf-1-7' });
    expect(step.start).toHaveBeenCalledTimes(1);
  });

  it('starts the step before the body runs', async () => {
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    step.start.mockImplementation(() => {
      order.push('start');
      return Promise.resolve();
    });
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock body with no awaitable work
    const activity = plugin().activity(() => {
      order.push('body');
      return Promise.resolve();
    });

    await activity(input);

    expect(order).toEqual(['start', 'body']);
  });

  it('hands the step to the body', async () => {
    const activity = plugin().activity(async (context, toolInput: ToolStepInput) => {
      await context.step.send({ type: 'output' });
      return toolInput.toolName;
    });

    await expect(activity({ ids, invocation, toolName: 'getStockPrice' })).resolves.toBe('getStockPrice');
    expect(step.send).toHaveBeenCalledWith({ type: 'output' });
  });

  it('closes the step when the body returns, letting the reason be derived', async () => {
    const activity = plugin().activity(noop);

    await activity(input);

    expect(step.end).toHaveBeenCalledTimes(1);
    expect(step.end).toHaveBeenCalledWith();
  });

  it('leaves a body that closed the step with its own reason alone, since end is idempotent', async () => {
    const activity = plugin().activity(async (context) => {
      await context.step.end({ reason: 'cancelled' });
    });

    await activity(input);

    // The scaffold still calls end; the SDK makes the second call a no-op, so the
    // body's reason is the one that reached the wire.
    expect(step.end).toHaveBeenNthCalledWith(1, { reason: 'cancelled' });
    expect(step.end).toHaveBeenCalledTimes(2);
  });

  it('leaves the step open when the body throws, so a retry supersedes this attempt', async () => {
    const failure = new Error('tool exploded');
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock body with no awaitable work
    const activity = plugin().activity(() => Promise.reject(failure));

    await expect(activity(input)).rejects.toBe(failure);
    expect(step.end).not.toHaveBeenCalled();
  });
});
