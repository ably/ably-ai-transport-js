/**
 * WireMeta builder unit tests.
 *
 * `wireMetaFromMessage` reads one inbound Ably message into its transport-tier
 * WireMeta: the raw `transport` / `codec` header buckets verbatim, plus a typed
 * convenience projection of the transport tier's identity and structure fields
 * and the message's own Ably fields. It never interprets structure fields.
 */

import { describe, expect, it } from 'vitest';

import {
  HEADER_INPUT_TRANSPORT_MESSAGE_ID,
  HEADER_INPUT_TRANSPORT_MESSAGE_IDS,
  HEADER_ROLE,
  HEADER_RUN_ID,
  HEADER_STEER_TRANSPORT_MESSAGE_IDS,
  HEADER_STEP_ID,
  HEADER_STEP_START_SERIAL,
  HEADER_TRANSPORT_MESSAGE_ID,
} from '../../../src/constants.js';
import { wireMetaFromMessage } from '../../../src/core/transport/wire-meta.js';
import { inboundMessage } from '../../helper/wire-messages.js';

describe('wireMetaFromMessage', () => {
  it('carries the raw transport and codec header buckets verbatim', () => {
    const transport = { [HEADER_RUN_ID]: 'R1', 'run-client-id': 'c1', 'invocation-id': 'I1' };
    const codec = { stream: 'true', status: 'streaming', 'stream-id': 'S1' };

    const meta = wireMetaFromMessage(inboundMessage({ transport, codec }));

    expect(meta.transport).toEqual(transport);
    expect(meta.codec).toEqual(codec);
  });

  it('surfaces user headers from Ably extras.headers, outside the ai envelope', () => {
    const meta = wireMetaFromMessage(inboundMessage({ headers: { 'x-tenant': 'acme', 'x-trace': 't1' } }));

    expect(meta.headers).toEqual({ 'x-tenant': 'acme', 'x-trace': 't1' });
  });

  it('projects the typed identity fields off the transport tier and Ably fields', () => {
    const meta = wireMetaFromMessage(
      inboundMessage({
        name: 'ai-output',
        transport: {
          [HEADER_TRANSPORT_MESSAGE_ID]: 'm1',
          [HEADER_RUN_ID]: 'R1',
          [HEADER_STEP_ID]: 'step1',
          [HEADER_STEP_START_SERIAL]: 'ss1',
          [HEADER_ROLE]: 'assistant',
        },
        serial: 's1',
        timestamp: 1000,
        clientId: 'agent-client',
        versionSerial: 'v1',
        versionTimestamp: 2000,
      }),
    );

    expect(meta).toMatchObject({
      serial: 's1',
      transportMessageId: 'm1',
      runId: 'R1',
      stepId: 'step1',
      stepStartSerial: 'ss1',
      timestamp: 1000,
      role: 'assistant',
      clientId: 'agent-client',
      messageName: 'ai-output',
      versionSerial: 'v1',
      versionTimestamp: 2000,
    });
  });

  it('carries the structure fields through without interpreting them', () => {
    const meta = wireMetaFromMessage(
      inboundMessage({
        transport: {
          [HEADER_INPUT_TRANSPORT_MESSAGE_ID]: 'i1',
        },
      }),
    );

    expect(meta).toMatchObject({ inputTransportMessageId: 'i1' });
  });

  it('parses the steer-transport-message-ids stamp into the typed field', () => {
    const meta = wireMetaFromMessage(
      inboundMessage({ transport: { [HEADER_STEER_TRANSPORT_MESSAGE_IDS]: '["s1","s2"]' } }),
    );

    expect(meta.steerTransportMessageIds).toEqual(['s1', 's2']);
  });

  it('parses the input-transport-message-ids receipt into the typed field', () => {
    const meta = wireMetaFromMessage(
      inboundMessage({ transport: { [HEADER_INPUT_TRANSPORT_MESSAGE_IDS]: '["in-1","steer-1"]' } }),
    );

    expect(meta.inputTransportMessageIds).toEqual(['in-1', 'steer-1']);
  });

  it('degrades a malformed steer stamp to undefined, keeping the raw header', () => {
    const meta = wireMetaFromMessage(inboundMessage({ transport: { [HEADER_STEER_TRANSPORT_MESSAGE_IDS]: '{bad' } }));

    expect(meta.steerTransportMessageIds).toBeUndefined();
    expect(meta.transport[HEADER_STEER_TRANSPORT_MESSAGE_IDS]).toBe('{bad');
  });

  it('leaves every typed field undefined when the headers and Ably fields are absent', () => {
    const meta = wireMetaFromMessage(inboundMessage({}));

    // toEqual treats undefined-valued properties as absent, so this pins
    // exactly: raw buckets empty, every typed projection undefined.
    expect(meta).toEqual({ transport: {}, codec: {}, headers: {} });
  });

  it('yields empty buckets when the message carries no extras at all', () => {
    const meta = wireMetaFromMessage(inboundMessage({ extras: undefined }));

    expect(meta.transport).toEqual({});
    expect(meta.codec).toEqual({});
    expect(meta.headers).toEqual({});
  });
});
