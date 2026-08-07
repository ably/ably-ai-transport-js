import * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import {
  errorCause,
  errorMessage,
  getCodecHeaders,
  getTransportHeaders,
  hasAiEnvelope,
  mergeHeaders,
  parseBool,
  parseJson,
  stripUndefined,
} from '../src/utils.js';

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the message of an Ably.ErrorInfo', () => {
    expect(errorMessage(new Ably.ErrorInfo('nope', 40000, 400))).toBe('nope');
  });

  it('stringifies a non-Error value', () => {
    const nothing: unknown = undefined;
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(nothing)).toBe('undefined');
  });
});

describe('errorCause', () => {
  it('returns the value when it is an Ably.ErrorInfo', () => {
    const info = new Ably.ErrorInfo('nope', 40000, 400);
    expect(errorCause(info)).toBe(info);
  });

  it('returns undefined for a plain Error', () => {
    expect(errorCause(new Error('boom'))).toBeUndefined();
  });

  it('returns undefined for a non-error value', () => {
    const nothing: unknown = undefined;
    expect(errorCause('oops')).toBeUndefined();
    expect(errorCause(nothing)).toBeUndefined();
  });
});

describe('getTransportHeaders', () => {
  it('extracts the transport tier from a well-formed message', () => {
    const msg = { extras: { ai: { transport: { 'run-id': 'r1' }, codec: { type: 'text' } } } } as Ably.InboundMessage;
    expect(getTransportHeaders(msg)).toEqual({ 'run-id': 'r1' });
  });

  it('returns empty object when the transport tier is absent', () => {
    const msg = { extras: { ai: { codec: { type: 'text' } } } } as Ably.InboundMessage;
    expect(getTransportHeaders(msg)).toEqual({});
  });

  it('returns empty object when extras is undefined', () => {
    const msg = { extras: undefined } as Ably.InboundMessage;
    expect(getTransportHeaders(msg)).toEqual({});
  });

  it('returns empty object when extras is falsy', () => {
    // CAST: testing runtime guard against falsy extras values
    const msg = { extras: 0 } as unknown as Ably.InboundMessage;
    expect(getTransportHeaders(msg)).toEqual({});
  });

  it('returns empty object when ai is missing', () => {
    const msg = { extras: {} } as Ably.InboundMessage;
    expect(getTransportHeaders(msg)).toEqual({});
  });

  it('returns empty object when extras is not an object', () => {
    const msg = { extras: 'string' } as Ably.InboundMessage;
    expect(getTransportHeaders(msg)).toEqual({});
  });
});

describe('getCodecHeaders', () => {
  it('extracts the codec tier from a well-formed message', () => {
    const msg = { extras: { ai: { transport: { 'run-id': 'r1' }, codec: { type: 'text' } } } } as Ably.InboundMessage;
    expect(getCodecHeaders(msg)).toEqual({ type: 'text' });
  });

  it('returns empty object when the codec tier is absent', () => {
    const msg = { extras: { ai: { transport: { 'run-id': 'r1' } } } } as Ably.InboundMessage;
    expect(getCodecHeaders(msg)).toEqual({});
  });

  it('returns empty object when extras is undefined', () => {
    const msg = { extras: undefined } as Ably.InboundMessage;
    expect(getCodecHeaders(msg)).toEqual({});
  });

  it('returns empty object when ai is missing', () => {
    const msg = { extras: {} } as Ably.InboundMessage;
    expect(getCodecHeaders(msg)).toEqual({});
  });

  it('returns empty object when extras is not an object', () => {
    const msg = { extras: 'string' } as Ably.InboundMessage;
    expect(getCodecHeaders(msg)).toEqual({});
  });
});

describe('hasAiEnvelope', () => {
  it('is true for a message carrying either tier', () => {
    expect(hasAiEnvelope({ extras: { ai: { transport: { 'run-id': 'r1' } } } } as Ably.InboundMessage)).toBe(true);
    expect(hasAiEnvelope({ extras: { ai: { codec: { kind: 'text' } } } } as Ably.InboundMessage)).toBe(true);
  });

  it('is true for an empty envelope — the envelope itself is the marker', () => {
    expect(hasAiEnvelope({ extras: { ai: {} } } as Ably.InboundMessage)).toBe(true);
  });

  it('is false for a foreign message carrying only application headers', () => {
    expect(hasAiEnvelope({ extras: { headers: { topic: 'support' } } } as Ably.InboundMessage)).toBe(false);
  });

  it('is false when extras is absent, falsy, or not an object', () => {
    expect(hasAiEnvelope({ extras: undefined } as Ably.InboundMessage)).toBe(false);
    // CAST: testing the runtime guard against non-object extras values.
    expect(hasAiEnvelope({ extras: 0 } as unknown as Ably.InboundMessage)).toBe(false);
    expect(hasAiEnvelope({ extras: 'string' } as Ably.InboundMessage)).toBe(false);
    expect(hasAiEnvelope({} as Ably.InboundMessage)).toBe(false);
  });

  it('is false when ai is present but not an object', () => {
    // CAST: testing the runtime guard against a non-object `ai` value.
    expect(hasAiEnvelope({ extras: { ai: 'nope' } } as unknown as Ably.InboundMessage)).toBe(false);
    expect(hasAiEnvelope({ extras: { ai: 0 } } as unknown as Ably.InboundMessage)).toBe(false);
  });
});

describe('parseJson', () => {
  it('parses valid JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseJson('not json')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- testing explicit undefined arg
    expect(parseJson(undefined)).toBeUndefined();
  });

  it('parses arrays', () => {
    expect(parseJson('[1,2]')).toEqual([1, 2]);
  });
});

describe('mergeHeaders', () => {
  it('returns empty when both undefined', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- testing explicit undefined args
    expect(mergeHeaders(undefined, undefined)).toEqual({});
  });

  it('returns base when overrides is undefined', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- testing explicit undefined arg
    expect(mergeHeaders({ a: '1' }, undefined)).toEqual({ a: '1' });
  });

  it('returns overrides when base is undefined', () => {
    expect(mergeHeaders(undefined, { b: '2' })).toEqual({ b: '2' });
  });

  it('overrides win over base', () => {
    expect(mergeHeaders({ a: '1', b: '2' }, { b: '3', c: '4' })).toEqual({ a: '1', b: '3', c: '4' });
  });
});

describe('parseBool', () => {
  it('returns true for "true"', () => {
    expect(parseBool('true')).toBe(true);
  });

  it('returns false for "false"', () => {
    expect(parseBool('false')).toBe(false);
  });

  it('returns false for other strings', () => {
    expect(parseBool('yes')).toBe(false);
  });

  it('returns undefined for undefined', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- testing explicit undefined arg
    expect(parseBool(undefined)).toBeUndefined();
  });
});

describe('stripUndefined', () => {
  it('removes undefined values', () => {
    const result = stripUndefined({ a: 'keep', b: undefined, c: 42 });
    expect(result).toEqual({ a: 'keep', c: 42 });
    expect('b' in result).toBe(false);
  });

  it('preserves all values when none are undefined', () => {
    const result = stripUndefined({ x: 'hello', y: 0, z: false });
    expect(result).toEqual({ x: 'hello', y: 0, z: false });
  });

  it('returns empty object when all values are undefined', () => {
    const result = stripUndefined({ a: undefined, b: undefined });
    expect(result).toEqual({});
  });

  it('preserves null, empty string, zero, and false', () => {
    // eslint-disable-next-line unicorn/no-null -- testing null preservation
    const result = stripUndefined({ a: null, b: '', c: 0, d: false });
    // eslint-disable-next-line unicorn/no-null -- testing null preservation
    expect(result).toEqual({ a: null, b: '', c: 0, d: false });
  });

  it('does not mutate the input', () => {
    const input = { a: 'keep', b: undefined };
    const result = stripUndefined(input);
    expect(result).not.toBe(input);
    expect(input).toHaveProperty('b');
  });
});
