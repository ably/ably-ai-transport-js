import * as Ably from 'ably';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import {
  createDeferredContinuationStream,
  createRunOutputStream,
  DEFERRED_CONTINUATION_TIMEOUT_MS,
} from '../../../src/vercel/transport/run-output-stream.js';
import { drain, flushMicrotasks } from '../../helper/streams.js';

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
  /** Emit a Tree `output` event, optionally carrying a triggering input-codec-message-id. */
  output: (runId: string, events: VercelOutput[], inputCodecMessageId?: string) => void;
  /** Emit a Tree `run` run-end event with the given reason. */
  runEnd: (runId: string, reason: string) => void;
  /** Emit a Tree `run` run-suspend event. */
  runSuspend: (runId: string) => void;
  /** Emit a session `error`. */
  error: (reason: Ably.ErrorInfo) => void;
}

// `opts.runStatus` is the lifecycle status `tree.getRunNode` reports for any
// queried run; omit it so `getRunNode` returns undefined (no such run).
const createMockSession = (opts?: {
  runStatus?: 'active' | 'suspended' | 'complete' | 'cancelled' | 'error';
}): MockSession => {
  const treeEmitter = makeEmitter();
  const sessionEmitter = makeEmitter();

  // CAST: the test only exercises `state.status`, so a minimal RunNode stand-in
  // suffices for the snapshot pre-check in createDeferredContinuationStream.
  const getRunNode = vi.fn((runId: string) =>
    opts?.runStatus === undefined ? undefined : { runId, state: { status: opts.runStatus } },
  );
  const tree = { on: vi.fn(treeEmitter.on), getRunNode } as unknown as VercelSession['tree'];
  const session = {
    tree,
    on: vi.fn(sessionEmitter.on),
  } as unknown as VercelSession;

  return {
    session,
    output: (runId, events, inputCodecMessageId) => {
      treeEmitter.emit('output', { runId, inputCodecMessageId, codecMessageId: 'm-1', serial: 's-1', events });
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
    runSuspend: (runId) => {
      treeEmitter.emit('run', {
        type: 'suspend',
        runId,
        clientId: '',
        invocationId: 'inv-1',
        serial: 's-1',
      });
    },
    error: (reason) => {
      sessionEmitter.emit('error', reason);
    },
  };
};

const textDelta = (delta: string): VercelOutput => ({ type: 'text-delta', id: 't1', delta });
const finish = (): VercelOutput => ({ type: 'finish' });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRunOutputStream', () => {
  it('enqueues output events for the matching input and closes on a terminal chunk', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'u-1');

    mock.output('run-1', [textDelta('hel'), textDelta('lo')], 'u-1');
    mock.output('run-1', [finish()], 'u-1');

    const events = await drain(stream);
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'text-delta', 'finish']);
  });

  it('ignores output events for other inputs', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'u-1');

    mock.output('run-1', [textDelta('nope')], 'u-2');
    mock.output('run-1', [finish()], 'u-1');

    const events = await drain(stream);
    expect(events.map((e) => e.type)).toEqual(['finish']);
  });

  it('routes by input-codec-message-id independently of the runId', async () => {
    const mock = createMockSession();
    // Open the stream keyed by the triggering input id, with a runId promise
    // the agent resolves once it mints its own run-id.
    const { stream } = createRunOutputStream(mock.session, Promise.resolve('run-agent'), 'u-1');

    // An output under a different (agent-minted) runId still routes here
    // because it carries the matching input-codec-message-id.
    mock.output('run-agent', [textDelta('hi')], 'u-1');
    // An output for a different input is ignored even though the runId matches.
    mock.output('run-agent', [textDelta('nope')], 'u-2');
    mock.output('run-agent', [finish()], 'u-1');

    const events = await drain(stream);
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'finish']);
  });

  it('ignores an output carrying no input-codec-message-id', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'u-1');

    // Routing is purely by input id now; an output with no input id (e.g. a
    // local fold with no wire echo yet) does not route to this stream.
    mock.output('run-1', [textDelta('orphan')]);
    mock.output('run-1', [finish()], 'u-1');

    const events = await drain(stream);
    expect(events.map((e) => e.type)).toEqual(['finish']);
  });

  it('does not close on a run-suspend but closes on a terminal run-end', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'u-1');
    // The run-end safety-net keys on the resolved runId; let the promise settle.
    await Promise.resolve();

    mock.output('run-1', [textDelta('partial')], 'u-1');
    // A run-suspend (e.g. awaiting a tool result) must NOT close the consumer
    // stream — the run continues.
    mock.runSuspend('run-1');
    mock.output('run-1', [textDelta('more')], 'u-1');
    // A terminal run-end closes the stream as a safety net.
    mock.runEnd('run-1', 'complete');

    const events = await drain(stream);
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'text-delta']);
  });

  it('errors the stream when the session emits an error', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'u-1');

    const reason = new Ably.ErrorInfo('channel continuity lost', ErrorCode.SessionSubscriptionError, 500);
    mock.error(reason);

    await expect(drain(stream)).rejects.toBe(reason);
  });

  it('close() is idempotent and ends the stream', async () => {
    const mock = createMockSession();
    const { stream, close } = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'u-1');

    close();
    close();

    const events = await drain(stream);
    expect(events).toEqual([]);
  });

  it('a session error settles the stream and a later close() is a no-op', async () => {
    const mock = createMockSession();
    const { stream, close } = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'u-1');

    const reason = new Ably.ErrorInfo('post failed', ErrorCode.SessionSubscriptionError, 500);
    mock.error(reason);
    // Once errored, a subsequent close must not throw or override the error.
    close();

    await expect(drain(stream)).rejects.toBe(reason);
  });

  it('output and run-end after settling are ignored', async () => {
    const mock = createMockSession();
    const { stream, close } = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'u-1');

    close();
    // Late events must not throw against the closed controller.
    mock.output('run-1', [textDelta('late')], 'u-1');
    mock.runEnd('run-1', 'complete');

    const events = await drain(stream);
    expect(events).toEqual([]);
  });
});

describe('createDeferredContinuationStream', () => {
  it('closes immediately when there is no run to observe', async () => {
    const mock = createMockSession();
    const noRunId: string | undefined = undefined;
    const { stream } = createDeferredContinuationStream(mock.session, noRunId);

    // Nothing to wait for — the stream closes (on a microtask) without events.
    await expect(drain(stream)).resolves.toEqual([]);
  });

  it('closes immediately when the run is already terminal', async () => {
    // The run ended before this stream subscribed (snapshot pre-check): the Tree
    // is at rest, so there is no future event to wait for.
    const mock = createMockSession({ runStatus: 'complete' });
    const { stream } = createDeferredContinuationStream(mock.session, 'run-1');

    await expect(drain(stream)).resolves.toEqual([]);
  });

  it('stays open while the run is suspended, then closes on run-end', async () => {
    const mock = createMockSession({ runStatus: 'suspended' });
    const { stream } = createDeferredContinuationStream(mock.session, 'run-1');

    let closed = false;
    const drained = drain(stream).then((events) => {
      closed = true;
      return events;
    });

    await flushMicrotasks();
    expect(closed).toBe(false);

    mock.runEnd('run-1', 'complete');
    // Chunk-less: it forwards no outputs, only closes.
    await expect(drained).resolves.toEqual([]);
    expect(closed).toBe(true);
  });

  it('closes on the first output for the run (the agent resumed)', async () => {
    const mock = createMockSession({ runStatus: 'active' });
    const { stream } = createDeferredContinuationStream(mock.session, 'run-1');

    // A new output for the run signals the continuation is producing its turn;
    // the stream closes (without forwarding the chunk) so useMessageSync repaints.
    mock.output('run-1', [textDelta('hi')], 'some-input');
    await expect(drain(stream)).resolves.toEqual([]);
  });

  it('ignores output and run-end for other runs', async () => {
    const mock = createMockSession({ runStatus: 'suspended' });
    const { stream } = createDeferredContinuationStream(mock.session, 'run-1');

    let closed = false;
    const drained = drain(stream).then(() => {
      closed = true;
    });

    mock.output('run-2', [textDelta('x')], 'i');
    mock.runEnd('run-2', 'complete');
    await flushMicrotasks();
    expect(closed).toBe(false);

    mock.runEnd('run-1', 'complete');
    await drained;
    expect(closed).toBe(true);
  });

  it('errors the stream when the session emits an error', async () => {
    const mock = createMockSession({ runStatus: 'suspended' });
    const { stream } = createDeferredContinuationStream(mock.session, 'run-1');

    const reason = new Ably.ErrorInfo('channel continuity lost', ErrorCode.SessionSubscriptionError, 500);
    mock.error(reason);

    await expect(drain(stream)).rejects.toBe(reason);
  });

  it('closes on timeout when the run never produces its next turn', async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockSession({ runStatus: 'suspended' });
      const { stream } = createDeferredContinuationStream(mock.session, 'run-1');

      const drained = drain(stream);
      vi.advanceTimersByTime(DEFERRED_CONTINUATION_TIMEOUT_MS);

      await expect(drained).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() is idempotent and ends the stream', async () => {
    const mock = createMockSession({ runStatus: 'suspended' });
    const { stream, close } = createDeferredContinuationStream(mock.session, 'run-1');

    close();
    close();

    await expect(drain(stream)).resolves.toEqual([]);
  });
});
