/**
 * Cancel-envelope unit tests.
 *
 * The publish side (buildCancelMessage) and the read side (readCancelTarget)
 * are inverses over the cancel wire shape: the target run-id round-trips, an
 * event-id is always stamped for rewind redelivery but is never read back
 * (cancels are idempotent), and a malformed cancel surfaces as an undefined
 * run-id.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { EVENT_CANCEL, HEADER_EVENT_ID, HEADER_RUN_ID } from '../../../src/constants.js';
import { buildCancelMessage, readCancelTarget } from '../../../src/core/transport/cancel-envelope.js';

// The transport headers carried under the message's `extras.ai.transport`.
const transportHeaders = (msg: Ably.Message): Record<string, string> =>
  // CAST: extras is `any` in the Ably types; the builder always nests headers here.
  (msg.extras as { ai: { transport: Record<string, string> } }).ai.transport;

// Build an inbound cancel message carrying the given transport headers.
const inbound = (headers: Record<string, string>): Ably.InboundMessage =>
  ({ name: EVENT_CANCEL, extras: { ai: { transport: headers } } }) as unknown as Ably.InboundMessage;

describe('buildCancelMessage', () => {
  it('names the message ai-cancel and stamps a fresh event-id', () => {
    const msg = buildCancelMessage({ runId: 'R1' });
    expect(msg.name).toBe(EVENT_CANCEL);
    expect(transportHeaders(msg)[HEADER_EVENT_ID]).toEqual(expect.any(String));
  });

  it('mints a distinct event-id per call', () => {
    const a = transportHeaders(buildCancelMessage({ runId: 'R1' }))[HEADER_EVENT_ID];
    const b = transportHeaders(buildCancelMessage({ runId: 'R1' }))[HEADER_EVENT_ID];
    expect(a).not.toBe(b);
  });

  it('stamps the target run-id', () => {
    const headers = transportHeaders(buildCancelMessage({ runId: 'R1' }));
    expect(headers[HEADER_RUN_ID]).toBe('R1');
  });
});

describe('readCancelTarget', () => {
  it('reads back the run-id built by buildCancelMessage', () => {
    const built = buildCancelMessage({ runId: 'R1' });
    const target = readCancelTarget(inbound(transportHeaders(built)));
    expect(target).toEqual({ runId: 'R1' });
  });

  it('ignores the event-id — cancels are idempotent', () => {
    const target = readCancelTarget(inbound({ [HEADER_EVENT_ID]: 'E1', [HEADER_RUN_ID]: 'R1' }));
    expect(target).toEqual({ runId: 'R1' });
  });

  it('returns an undefined run-id for a malformed cancel', () => {
    expect(readCancelTarget(inbound({ [HEADER_EVENT_ID]: 'E1' }))).toEqual({ runId: undefined });
  });
});
