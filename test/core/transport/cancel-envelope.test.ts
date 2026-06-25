/**
 * Cancel-envelope unit tests.
 *
 * The publish side (buildCancelMessage) and the read side (readCancelTarget)
 * are inverses over the cancel wire shape: the target identifiers round-trip,
 * an event-id is always stamped for rewind redelivery but is never read back
 * (cancels are idempotent), and a malformed cancel surfaces as both fields
 * undefined.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { EVENT_CANCEL, HEADER_EVENT_ID, HEADER_INPUT_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../../src/constants.js';
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

  it('stamps run-id when targeting a continuation', () => {
    const headers = transportHeaders(buildCancelMessage({ runId: 'R1' }));
    expect(headers[HEADER_RUN_ID]).toBe('R1');
    expect(headers[HEADER_INPUT_CODEC_MESSAGE_ID]).toBeUndefined();
  });

  it('stamps input-codec-message-id when targeting a fresh send', () => {
    const headers = transportHeaders(buildCancelMessage({ inputCodecMessageId: 'C1' }));
    expect(headers[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('C1');
    expect(headers[HEADER_RUN_ID]).toBeUndefined();
  });

  it('stamps both identifiers when both are supplied', () => {
    const headers = transportHeaders(buildCancelMessage({ runId: 'R1', inputCodecMessageId: 'C1' }));
    expect(headers[HEADER_RUN_ID]).toBe('R1');
    expect(headers[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('C1');
  });
});

describe('readCancelTarget', () => {
  it('reads back the target identifiers built by buildCancelMessage', () => {
    const built = buildCancelMessage({ runId: 'R1', inputCodecMessageId: 'C1' });
    const target = readCancelTarget(inbound(transportHeaders(built)));
    expect(target).toEqual({ runId: 'R1', inputCodecMessageId: 'C1' });
  });

  it('ignores the event-id — cancels are idempotent', () => {
    const target = readCancelTarget(inbound({ [HEADER_EVENT_ID]: 'E1', [HEADER_RUN_ID]: 'R1' }));
    expect(target).toEqual({ runId: 'R1', inputCodecMessageId: undefined });
  });

  it('returns both fields undefined for a malformed cancel carrying neither identifier', () => {
    expect(readCancelTarget(inbound({ [HEADER_EVENT_ID]: 'E1' }))).toEqual({
      runId: undefined,
      inputCodecMessageId: undefined,
    });
  });
});
