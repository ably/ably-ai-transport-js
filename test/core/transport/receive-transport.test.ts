/**
 * Receive-transport unit tests.
 *
 * The receive side has two pieces. `classifyWireMessage` turns one raw wire
 * message into a typed TransportEvent (run-lifecycle, step-lifecycle, or a
 * codec-decoded message) or filters it. `createReceiveTransport` wraps the
 * classifier in the public event emitter a developer subscribes to, emitting
 * `event` then `ably-message`, and turning a decode failure into an `error`
 * that drops the one message.
 */

import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_START,
  EVENT_STEP_END,
  EVENT_STEP_START,
  HEADER_RUN_ID,
  HEADER_STEP_ID,
} from '../../../src/constants.js';
import type { Decoder } from '../../../src/core/codec/types.js';
import { classifyWireMessage, createReceiveTransport } from '../../../src/core/transport/receive-transport.js';
import type { CodecInputEvent } from '../../../src/core/transport/session-codec.js';
import type { TransportEvent } from '../../../src/core/transport/types/transport.js';
import { silentLogger } from '../../helper/logger.js';
import { foreignWire, inboundMessage } from '../../helper/wire-messages.js';

// ---------------------------------------------------------------------------
// Test types + mocks
// ---------------------------------------------------------------------------

interface TestInput extends CodecInputEvent {
  kind: 'in';
}
interface TestOutput {
  type: 'out';
}
const makeDecoder = (inputs: TestInput[], outputs: TestOutput[]): Decoder<TestInput, TestOutput> => ({
  decode: vi.fn(() => ({ inputs: [...inputs], outputs: [...outputs] })),
});

const throwingDecoder = (err: unknown): Decoder<TestInput, TestOutput> => ({
  decode: vi.fn(() => {
    throw err;
  }),
});

// Thin wrapper over the shared builder pinning this file's defaults: name
// 'msg', serial 's1', timestamp 1000, `headers` → the transport bucket.
const msg = (opts: {
  name?: string;
  headers?: Record<string, string>;
  serial?: string;
  timestamp?: number;
  version?: string;
}): Ably.InboundMessage =>
  inboundMessage({
    name: opts.name ?? 'msg',
    transport: opts.headers ?? {},
    serial: opts.serial ?? 's1',
    timestamp: opts.timestamp ?? 1000,
    versionSerial: opts.version,
  });

// ---------------------------------------------------------------------------
// classifyWireMessage
// ---------------------------------------------------------------------------

describe('classifyWireMessage', () => {
  it('classifies a run-start into a run-lifecycle event, never touching the decoder', () => {
    // Capture the decode spy locally — asserting on a Decoder method directly
    // trips the unbound-method lint.
    const decode = vi.fn(() => ({ inputs: [] as TestInput[], outputs: [] as TestOutput[] }));
    const event = classifyWireMessage(
      { decode },
      msg({ name: EVENT_RUN_START, headers: { [HEADER_RUN_ID]: 'R1', 'run-client-id': 'c1' }, serial: 's1' }),
    );

    expect(event?.kind).toBe('run-lifecycle');
    expect(event?.kind === 'run-lifecycle' ? event.event : undefined).toMatchObject({ type: 'start', runId: 'R1' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('classifies a step-start into a step-lifecycle event, never touching the decoder', () => {
    const decode = vi.fn(() => ({ inputs: [] as TestInput[], outputs: [] as TestOutput[] }));
    const event = classifyWireMessage(
      { decode },
      msg({ name: EVENT_STEP_START, headers: { [HEADER_RUN_ID]: 'R1', [HEADER_STEP_ID]: 'S' }, serial: 's1' }),
    );

    expect(event?.kind).toBe('step-lifecycle');
    expect(event?.kind === 'step-lifecycle' ? event.event : undefined).toMatchObject({
      type: 'step-start',
      runId: 'R1',
      stepId: 'S',
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it('classifies a codec message carrying decoded events and the raw header buckets', () => {
    const event = classifyWireMessage(
      makeDecoder([], [{ type: 'out' }]),
      msg({ headers: { [HEADER_RUN_ID]: 'R1' }, serial: 's2', timestamp: 1234, version: 's2@3' }),
    );

    // Only the identity fields are checked here; the full meta projection is
    // pinned exhaustively in wire-meta.test.ts, which classifyWireMessage
    // delegates to.
    expect(event).toMatchObject({
      kind: 'message',
      inputs: [],
      outputs: [{ type: 'out' }],
      meta: { runId: 'R1', serial: 's2' },
    });
  });

  it.each<{ desc: string; opts: Parameters<typeof msg>[0] }>([
    { desc: 'a lifecycle name carrying no run-id', opts: { name: EVENT_RUN_END, headers: {} } },
    { desc: 'a step name missing its identifiers', opts: { name: EVENT_STEP_END, headers: { [HEADER_RUN_ID]: 'R1' } } },
    { desc: 'a wire-only carrier that decodes to nothing and carries no run-id', opts: { headers: {} } },
    { desc: 'a wire-only carrier whose run-id is an empty string', opts: { headers: { [HEADER_RUN_ID]: '' } } },
  ])('returns undefined for $desc', ({ opts }) => {
    const event = classifyWireMessage(makeDecoder([], []), msg(opts));
    expect(event).toBeUndefined();
  });

  // An application's own publish carries no SDK wire name and no `extras.ai`
  // envelope: the decoder yields nothing and there is no run-id, so nothing is
  // classified.
  it('classifies a foreign message to undefined', () => {
    const event = classifyWireMessage(makeDecoder([], []), foreignWire());
    expect(event).toBeUndefined();
  });

  it('classifies a run-id-only message with no decoded events', () => {
    const event = classifyWireMessage(makeDecoder([], []), msg({ headers: { [HEADER_RUN_ID]: 'R1' } }));
    expect(event).toMatchObject({ kind: 'message', inputs: [], outputs: [] });
  });

  it('propagates a decoder throw to the caller', () => {
    const boom = new Error('bad payload');
    expect(() => classifyWireMessage(throwingDecoder(boom), msg({ headers: {} }))).toThrow(boom);
  });
});

// ---------------------------------------------------------------------------
// createReceiveTransport
// ---------------------------------------------------------------------------

describe('createReceiveTransport', () => {
  it('emits the classified event and returns it from deliverEvent', () => {
    const receiver = createReceiveTransport(makeDecoder([], [{ type: 'out' }]), silentLogger);
    const seen: TransportEvent<TestInput, TestOutput>[] = [];
    receiver.on('event', (e) => seen.push(e));

    const returned = receiver.deliverEvent(msg({ headers: { [HEADER_RUN_ID]: 'R1' } }));

    expect(returned).toMatchObject({ outcome: 'classified', event: { kind: 'message' } });
    expect(seen).toHaveLength(1);
    expect(returned.outcome === 'classified' ? returned.event : undefined).toBe(seen[0]);
  });

  it('reports filtered and emits nothing for a wire-only carrier', () => {
    const receiver = createReceiveTransport(makeDecoder([], []), silentLogger);
    const onEvent = vi.fn();
    receiver.on('event', onEvent);

    const returned = receiver.deliverEvent(msg({ headers: {} }));

    expect(returned).toEqual({ outcome: 'filtered' });
    expect(onEvent).not.toHaveBeenCalled();
  });

  // An application's own publish on a channel it shares with a session: it
  // carries no SDK wire name and no `extras.ai` envelope, so the codec decoder
  // yields nothing and there is no run-id to make it a wire-only carrier. It
  // must surface as no typed event, while the raw message still flows via
  // deliverAblyMessage so the application can observe its own traffic.
  it('reports filtered for a foreign message but still emits its raw ably-message', () => {
    const receiver = createReceiveTransport(makeDecoder([], []), silentLogger);
    const onEvent = vi.fn();
    const raw: Ably.InboundMessage[] = [];
    receiver.on('event', onEvent);
    receiver.on('ably-message', (m) => raw.push(m));

    const wire = foreignWire();
    const returned = receiver.deliverEvent(wire);
    receiver.deliverAblyMessage(wire);

    expect(returned).toEqual({ outcome: 'filtered' });
    expect(onEvent).not.toHaveBeenCalled();
    expect(raw).toEqual([wire]);
  });

  it('turns a decode failure into an error, drops the message, and reports failed', () => {
    const receiver = createReceiveTransport(throwingDecoder(new Error('bad payload')), silentLogger);
    const onEvent = vi.fn();
    const onError = vi.fn();
    receiver.on('event', onEvent);
    receiver.on('error', onError);

    const returned = receiver.deliverEvent(msg({ headers: {} }));

    expect(returned).toEqual({ outcome: 'failed' });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('emits ably-message only via deliverAblyMessage, after the typed event', () => {
    const receiver = createReceiveTransport(makeDecoder([], [{ type: 'out' }]), silentLogger);
    const calls: string[] = [];
    receiver.on('event', () => calls.push('event'));
    receiver.on('ably-message', () => calls.push('ably-message'));

    const wire = msg({ headers: { [HEADER_RUN_ID]: 'R1' } });
    receiver.deliverEvent(wire);
    // deliverEvent alone does not emit the raw message.
    expect(calls).toEqual(['event']);

    receiver.deliverAblyMessage(wire);
    expect(calls).toEqual(['event', 'ably-message']);
  });

  it('emits an error via emitError for a caller-supplied channel failure', () => {
    const receiver = createReceiveTransport(makeDecoder([], []), silentLogger);
    const onError = vi.fn();
    receiver.on('error', onError);

    const err = new Ably.ErrorInfo('unable to subscribe; channel failed', 104001, 500);
    receiver.emitError(err);

    expect(onError).toHaveBeenCalledWith(err);
  });

  it('stops delivering events to an unsubscribed handler', () => {
    const receiver = createReceiveTransport(makeDecoder([], [{ type: 'out' }]), silentLogger);
    const onEvent = vi.fn();
    const off = receiver.on('event', onEvent);

    receiver.deliverEvent(msg({ headers: { [HEADER_RUN_ID]: 'R1' } }));
    off();
    receiver.deliverEvent(msg({ headers: { [HEADER_RUN_ID]: 'R1' } }));

    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
