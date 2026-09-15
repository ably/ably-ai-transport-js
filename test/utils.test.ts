import * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { errorCause, errorMessage, stripUndefined } from '../src/utils.js';

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
