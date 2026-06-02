import * as Ably from 'ably';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import { createRunOutputStream } from '../../../src/vercel/transport/run-output-stream.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type VercelSession = ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

/**
 * Minimal synchronous event registry mirroring the Tree/session
 * `on(event, handler)` contract: returns an unsubscribe and dispatches in
 * registration order. Lets the test drive the stream via the same `output` /
 * `run` / `error` events the production code subscribes to.
 * @returns An emitter with `on` (register, returns unsubscribe) and `emit`.
 */
const makeEmitter = (): {
  on: (event: string, handler: (arg: never) => void) => () => void;
  emit: (event: string, arg?: unknown) => void;
} => {
  const handlers = new Map<string, Set<(arg: never) => void>>();
  return {
    on: (event, handler) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    // CAST: the registry is untyped; the production `on` overloads guarantee
    // each handler receives the payload matching its event.
    emit: (event, arg) => {
      for (const handler of handlers.get(event) ?? []) (handler as (a: unknown) => void)(arg);
    },
  };
};

interface MockSession {
  session: VercelSession;
  /** Emit a Tree `output` event. */
  output: (runId: string, events: VercelOutput[]) => void;
  /** Emit a Tree `run` run-end event with the given reason. */
  runEnd: (runId: string, reason: string) => void;
  /** Emit a session `error`. */
  error: (reason: Ably.ErrorInfo) => void;
}

const createMockSession = (): MockSession => {
  const treeEmitter = makeEmitter();
  const sessionEmitter = makeEmitter();

  const tree = { on: vi.fn(treeEmitter.on) } as unknown as VercelSession['tree'];
  const session = {
    tree,
    on: vi.fn(sessionEmitter.on),
  } as unknown as VercelSession;

  return {
    session,
    output: (runId, events) => {
      treeEmitter.emit('output', { runId, codecMessageId: 'm-1', serial: 's-1', events });
    },
    runEnd: (runId, reason) => {
      treeEmitter.emit('run', {
        type: 'end',
        runId,
        clientId: '',
        invocationId: 'inv-1',
        serial: 's-1',
        reason,
      });
    },
    error: (reason) => {
      sessionEmitter.emit('error', reason);
    },
  };
};

const textDelta = (delta: string): VercelOutput => ({ type: 'text-delta', id: 't1', delta });
const finish = (): VercelOutput => ({ type: 'finish' });

const drain = async (stream: ReadableStream<VercelOutput>): Promise<VercelOutput[]> => {
  const reader = stream.getReader();
  const results: VercelOutput[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    results.push(value);
  }
  return results;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRunOutputStream', () => {
  it('enqueues output events for the matching run and closes on a terminal chunk', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, 'run-1');

    mock.output('run-1', [textDelta('hel'), textDelta('lo')]);
    mock.output('run-1', [finish()]);

    const events = await drain(stream);
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'text-delta', 'finish']);
  });

  it('ignores output events for other runs', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, 'run-1');

    mock.output('run-2', [textDelta('nope')]);
    mock.output('run-1', [finish()]);

    const events = await drain(stream);
    expect(events.map((e) => e.type)).toEqual(['finish']);
  });

  it('does not close on a suspended run-end but closes on a non-suspended one', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, 'run-1');

    mock.output('run-1', [textDelta('partial')]);
    // A suspended run-end (e.g. awaiting a tool result) must NOT close the
    // consumer stream — the run continues.
    mock.runEnd('run-1', 'suspended');
    mock.output('run-1', [textDelta('more')]);
    // A non-suspended run-end closes the stream as a safety net.
    mock.runEnd('run-1', 'complete');

    const events = await drain(stream);
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'text-delta']);
  });

  it('errors the stream when the session emits an error', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, 'run-1');

    const reason = new Ably.ErrorInfo('channel continuity lost', ErrorCode.SessionSubscriptionError, 500);
    mock.error(reason);

    await expect(drain(stream)).rejects.toBe(reason);
  });

  it('close() is idempotent and ends the stream', async () => {
    const mock = createMockSession();
    const { stream, close } = createRunOutputStream(mock.session, 'run-1');

    close();
    close();

    const events = await drain(stream);
    expect(events).toEqual([]);
  });

  it('error() settles the stream and a later close() is a no-op', async () => {
    const mock = createMockSession();
    const { stream, close, error } = createRunOutputStream(mock.session, 'run-1');

    const reason = new Ably.ErrorInfo('post failed', ErrorCode.SessionSubscriptionError, 500);
    error(reason);
    // Once errored, a subsequent close must not throw or override the error.
    close();

    await expect(drain(stream)).rejects.toBe(reason);
  });

  it('output and run-end after settling are ignored', async () => {
    const mock = createMockSession();
    const { stream, close } = createRunOutputStream(mock.session, 'run-1');

    close();
    // Late events must not throw against the closed controller.
    mock.output('run-1', [textDelta('late')]);
    mock.runEnd('run-1', 'complete');

    const events = await drain(stream);
    expect(events).toEqual([]);
  });
});
