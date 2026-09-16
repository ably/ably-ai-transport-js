import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { prepareHeaders, withHeaders } from '../../../src/core/transport/headers.js';
import { ErrorCode } from '../../../src/errors.js';

describe('prepareHeaders', () => {
  it('returns undefined for no headers or an empty map', () => {
    expect(prepareHeaders(undefined, 'send')).toBeUndefined();
    expect(prepareHeaders({}, 'send')).toBeUndefined();
  });

  it('keeps string, number, boolean and null values', () => {
    // eslint-disable-next-line unicorn/no-null -- null is a value Ably stores
    const headers = { s: 'x', n: 1, b: false, z: null };
    expect(prepareHeaders(headers, 'send')).toEqual(headers);
  });

  it('drops a key whose value is undefined and keeps the rest', () => {
    expect(prepareHeaders({ keep: 'x', drop: undefined }, 'pipe')).toEqual({ keep: 'x' });
    expect(prepareHeaders({ drop: undefined }, 'pipe')).toBeUndefined();
  });

  it('throws InvalidArgument naming the key for a value Ably would not store', () => {
    const rejected: unknown[] = [{}, [], () => 'x', Symbol('s')];
    for (const value of rejected) {
      expect(() => prepareHeaders({ ok: 'x', meta: value }, 'send')).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        statusCode: 400,
        message: "unable to send; header 'meta' is not a string, number, boolean or null",
      });
    }
    expect(() => prepareHeaders({ meta: {} }, 'pipe')).toThrowErrorInfo({
      message: "unable to pipe; header 'meta' is not a string, number, boolean or null",
    });
  });
});

describe('withHeaders', () => {
  const headers = { requestId: 'r1', id: 'caller' };

  it('creates extras.headers on a message that has none', () => {
    expect(withHeaders({ name: 'n', data: 'd' }, headers)).toEqual({
      name: 'n',
      data: 'd',
      extras: { headers },
    });
  });

  it("upserts the call's headers, preferring the header keys already in the message", () => {
    const message: Ably.Message = { name: 'n', extras: { headers: { id: 'm1' } } };
    expect(withHeaders(message, headers)).toEqual({ name: 'n', extras: { headers: { id: 'm1', requestId: 'r1' } } });
  });

  it('leaves extras.ai and every other extras key as they were', () => {
    const message: Ably.Message = { name: 'n', extras: { ai: { type: 't' }, ephemeral: true } };
    expect(withHeaders(message, headers)).toEqual({
      name: 'n',
      extras: { ai: { type: 't' }, ephemeral: true, headers },
    });
  });

  it('treats a non-object extras.headers as absent', () => {
    const message: Ably.Message = { name: 'n', extras: { headers: 'nope' } };
    expect(withHeaders(message, headers)).toEqual({ name: 'n', extras: { headers } });
  });

  it('mutates neither the message nor its extras', () => {
    const extras = { ai: { type: 't' }, headers: { id: 'm1' } };
    const message: Ably.Message = { name: 'n', extras };
    const stamped = withHeaders(message, headers);
    expect(stamped).not.toBe(message);
    expect(message.extras).toBe(extras);
    expect(extras).toEqual({ ai: { type: 't' }, headers: { id: 'm1' } });
  });
});
