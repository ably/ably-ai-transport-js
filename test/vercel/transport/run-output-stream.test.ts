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
  /** Emit a Tree `output` event, optionally carrying a triggering input event-id. */
  output: (runId: string, events: VercelOutput[], inputEventId?: string) => void;
  /** Emit a Tree `run` run-end event with the given reason. */
  runEnd: (runId: string, reason: string) => void;
  /** Emit a Tree `run` run-suspend event. */
  runSuspend: (runId: string) => void;
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
    output: (runId, events, inputEventId) => {
      treeEmitter.emit('output', {
        runId,
        inputCodecMessageId: undefined,
        inputEventId,
        codecMessageId: 'm-1',
        serial: 's-1',
        events,
      });
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

/**
 * Extract the `delta` strings of the text-delta chunks from a drained list.
 * @param events - The drained output events.
 * @returns The text deltas in order.
 */
const deltaText = (events: VercelOutput[]): string[] =>
  events.flatMap((e) => (e.type === 'text-delta' ? [e.delta] : []));

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

  it('separates two continuations of one run by event-id (multi-tab)', async () => {
    const mock = createMockSession();
    // Two tabs continue the SAME suspended run (same runId), each with its own
    // tool-result event-id. Each consumer must receive only its own follow-up.
    const a = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'evt-a');
    const b = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'evt-b');

    mock.output('run-1', [textDelta('A')], 'evt-a');
    mock.output('run-1', [textDelta('B')], 'evt-b');
    mock.output('run-1', [finish()], 'evt-a');
    mock.output('run-1', [finish()], 'evt-b');

    expect(deltaText(await drain(a.stream))).toEqual(['A']);
    expect(deltaText(await drain(b.stream))).toEqual(['B']);
  });

  it('routes by input event-id independently of the runId', async () => {
    const mock = createMockSession();
    // Open the stream keyed by the triggering input id, with a runId promise
    // the agent resolves once it mints its own run-id.
    const { stream } = createRunOutputStream(mock.session, Promise.resolve('run-agent'), 'u-1');

    // An output under a different (agent-minted) runId still routes here
    // because it carries the matching input event-id.
    mock.output('run-agent', [textDelta('hi')], 'u-1');
    // An output for a different input is ignored even though the runId matches.
    mock.output('run-agent', [textDelta('nope')], 'u-2');
    mock.output('run-agent', [finish()], 'u-1');

    const events = await drain(stream);
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'finish']);
  });

  it('ignores an output carrying no input event-id', async () => {
    const mock = createMockSession();
    const { stream } = createRunOutputStream(mock.session, Promise.resolve('run-1'), 'u-1');

    // Routing is purely by input event-id now; an output with no input event-id
    // (e.g. a local fold with no wire echo yet) does not route to this stream.
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
