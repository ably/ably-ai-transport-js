/**
 * `withAgentSession` unit tests.
 *
 * `createAgentSession` is mocked: everything this helper owns is orchestration
 * (create with the invocation's channel, connect, run the body, detach), so a
 * stub session makes each of those observable on its own. Real session
 * behaviour — including that `detach()` after `end()` is a no-op — belongs to
 * `agent-session.test.ts` and the durable integration test.
 */

import '../../helper/expectations.js';

import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Codec } from '../../../src/core/codec/types.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import type { InvocationData } from '../../../src/core/transport/invocation.js';
import { Invocation } from '../../../src/core/transport/invocation.js';
import type { AgentSession } from '../../../src/core/transport/types.js';
import { withAgentSession } from '../../../src/core/transport/with-agent-session.js';
import type { LogContext, Logger } from '../../../src/logger.js';
import { createMockClient } from '../../helper/mock-client.js';
import { flushMicrotasks } from '../../helper/streams.js';

vi.mock('../../../src/core/transport/agent-session.js', () => ({
  createAgentSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
}
interface TestProjection {
  messages: TestMessage[];
}
interface TestInput {
  kind: 'input';
}
interface TestOutput {
  type: 'output';
}

type TestCodec = Codec<TestInput, TestOutput, TestProjection, TestMessage>;
type TestSession = AgentSession<TestOutput, TestProjection, TestMessage>;

interface StubSession {
  connect: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

const createStubSession = (): StubSession => ({
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  connect: vi.fn(() => Promise.resolve()),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  detach: vi.fn(() => Promise.resolve()),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  end: vi.fn(() => Promise.resolve()),
});

/** Records every log call so the best-effort debug line is assertable. */
interface RecordingLogger extends Logger {
  calls: { level: string; message: string; context: LogContext | undefined }[];
}

const createRecordingLogger = (): RecordingLogger => {
  const calls: { level: string; message: string; context: LogContext | undefined }[] = [];
  const record =
    (level: string) =>
    (message: string, context?: LogContext): void => {
      calls.push({ level, message, context });
    };
  const logger: RecordingLogger = {
    calls,
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    withContext: () => logger,
  };
  return logger;
};

// CAST: the mocked `createAgentSession` never reads the codec; only pass-through
// to the factory is asserted.
const codec = { adapterTag: 'test-codec' } as unknown as TestCodec;

const invocationData: InvocationData = { inputEventId: 'evt-1', sessionName: 'ai:room-7' };

/** A body that does nothing. The `await` keeps it a genuine async function. */
const noopBody = async (): Promise<void> => {
  await Promise.resolve();
};

let session: StubSession;
let client: Ably.Realtime;
let clientClose: Ably.Realtime['close'];

const options = (): {
  client: Ably.Realtime;
  codec: TestCodec;
  invocation: InvocationData;
} => ({ client, codec, invocation: invocationData });

beforeEach(() => {
  vi.clearAllMocks();
  session = createStubSession();
  // CAST: the helper only calls connect/detach on the session it is handed.
  vi.mocked(createAgentSession).mockReturnValue(session as unknown as TestSession);
  // CAST: the channel is never resolved — `createAgentSession` is mocked.
  client = createMockClient({} as Ably.RealtimeChannel);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked needs the spy reference; the mock's close does not read `this`.
  clientClose = client.close;
});

describe('withAgentSession', () => {
  it('creates the session on the channel named by the invocation', async () => {
    await withAgentSession(options(), noopBody);

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ channelName: 'ai:room-7' }));
  });

  it('passes every other session option straight through', async () => {
    const logger = createRecordingLogger();
    await withAgentSession(
      {
        ...options(),
        logger,
        channelModes: ['OBJECT_SUBSCRIBE'],
        historyPageSize: 25,
        reorderWindowMs: 5_000,
      },
      noopBody,
    );

    expect(createAgentSession).toHaveBeenCalledWith({
      client,
      codec,
      logger,
      channelModes: ['OBJECT_SUBSCRIBE'],
      historyPageSize: 25,
      reorderWindowMs: 5_000,
      channelName: 'ai:room-7',
    });
    // `invocation` is consumed by the helper, not forwarded as a session option.
    expect(vi.mocked(createAgentSession).mock.calls[0]?.[0]).not.toHaveProperty('invocation');
  });

  it('connects before running the body', async () => {
    let connectedFirst = false;
    await withAgentSession(options(), async () => {
      connectedFirst = session.connect.mock.calls.length === 1;
      await Promise.resolve();
    });

    expect(connectedFirst).toBe(true);
  });

  it('hands the body the session and the parsed invocation', async () => {
    const seen = await withAgentSession(options(), async (context) => {
      await Promise.resolve();
      return context;
    });

    expect(seen.session).toBe(session);
    expect(seen.invocation).toBeInstanceOf(Invocation);
    expect(seen.invocation.sessionName).toBe('ai:room-7');
    expect(seen.invocation.inputEventId).toBe('evt-1');
  });

  it('returns the body value', async () => {
    await expect(
      withAgentSession(options(), async () => {
        await Promise.resolve();
        return 'outcome';
      }),
    ).resolves.toBe('outcome');
  });

  it('detaches after a successful body and leaves the injected client open', async () => {
    await withAgentSession(options(), noopBody);

    expect(session.detach).toHaveBeenCalledTimes(1);
    expect(session.end).not.toHaveBeenCalled();
    expect(vi.mocked(clientClose)).not.toHaveBeenCalled();
  });

  it('detaches and rethrows unchanged when the body throws', async () => {
    const failure = new Error('body failed');

    await expect(
      withAgentSession(options(), async () => {
        await Promise.resolve();
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(session.detach).toHaveBeenCalledTimes(1);
    expect(session.end).not.toHaveBeenCalled();
    expect(vi.mocked(clientClose)).not.toHaveBeenCalled();
  });

  it('waits for the body to settle before detaching', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const call = withAgentSession(options(), async () => {
      await pending;
      return 'late';
    });
    await flushMicrotasks();

    expect(session.connect).toHaveBeenCalledTimes(1);
    expect(session.detach).not.toHaveBeenCalled();

    release?.();
    await expect(call).resolves.toBe('late');
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it('still detaches once when the body ended the session itself', async () => {
    await withAgentSession(options(), async ({ session: handed }) => {
      await handed.end();
    });

    expect(session.end).toHaveBeenCalledTimes(1);
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it('swallows a detach failure on the success path and logs it at debug', async () => {
    const logger = createRecordingLogger();
    session.detach.mockRejectedValue(new Error('channel gone'));

    await expect(
      withAgentSession({ ...options(), logger }, async () => {
        await Promise.resolve();
        return 'outcome';
      }),
    ).resolves.toBe('outcome');

    const debugLines = logger.calls.filter((call) => call.level === 'debug');
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]?.message).toBe('withAgentSession(); session detach failed');
  });

  it('does not let a detach failure mask the body error', async () => {
    const failure = new Error('body failed');
    session.detach.mockRejectedValue(new Error('channel gone'));

    await expect(
      withAgentSession(options(), async () => {
        await Promise.resolve();
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('propagates a connect failure and still tears the session down', async () => {
    const failure = new Error('connect failed');
    session.connect.mockRejectedValue(failure);
    let bodyRan = false;

    await expect(
      withAgentSession(options(), async () => {
        bodyRan = true;
        await Promise.resolve();
      }),
    ).rejects.toBe(failure);

    expect(bodyRan).toBe(false);
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it('traces entry with the resolved channel name', async () => {
    const logger = createRecordingLogger();

    await withAgentSession({ ...options(), logger }, noopBody);

    const traceLines = logger.calls.filter((call) => call.level === 'trace');
    expect(traceLines).toHaveLength(1);
    expect(traceLines[0]?.context).toEqual({ sessionName: 'ai:room-7' });
  });
});
