import * as Ably from '@ably/pubsub-core';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/errors.js';
import { errorCause, errorMessage, responseText, stripUndefined, wrapReadError } from '../src/utils.js';

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

describe('wrapReadError', () => {
  it('keeps the code and status of an ErrorInfo, with the failure as cause', () => {
    const refused = new Ably.ErrorInfo('channel denied access', 40160, 401);

    expect(wrapReadError(refused)).toBeErrorInfo({
      message: 'unable to read the channel; channel denied access',
      code: 40160,
      statusCode: 401,
      cause: { code: 40160 },
    });
  });

  it('carries a PartialErrorInfo as an ErrorInfo cause, with InternalError for a missing code', () => {
    // eslint-disable-next-line unicorn/no-null -- ably-js reports a timed-out request with a null code
    const wrapped = wrapReadError(new Ably.PartialErrorInfo('Request timed out', null, 408));

    expect(wrapped).toBeErrorInfo({
      message: 'unable to read the channel; Request timed out',
      code: ErrorCode.InternalError,
      statusCode: 408,
      cause: { message: 'Request timed out', code: ErrorCode.InternalError, statusCode: 408 },
    });
    expect(wrapped.cause).toBeInstanceOf(Ably.ErrorInfo);
  });

  it('keeps the code of a PartialErrorInfo that has one', () => {
    expect(wrapReadError(new Ably.PartialErrorInfo('connection suspended', 80002, 400))).toBeErrorInfo({
      code: 80002,
      statusCode: 400,
    });
  });

  it('gives a PartialErrorInfo with no status 500, and keeps the ErrorInfo that caused it', () => {
    // CAST: ably-js gives a PartialErrorInfo an ErrorInfo cause, but its
    // declarations type that parameter with an ErrorInfo of their own.
    const lost = new Ably.ErrorInfo('connection lost', 80003, 400) as unknown as Ably.PartialErrorInfo;

    expect(wrapReadError(new Ably.PartialErrorInfo('history unavailable', 90000, undefined, lost))).toBeErrorInfo({
      code: 90000,
      statusCode: 500,
      cause: { code: 90000, statusCode: 500, cause: { code: 80003 } },
    });
  });

  it('reports a failure that is no ErrorInfo as InternalError with no cause', () => {
    const wrapped = wrapReadError(new TypeError('fetch failed'));

    expect(wrapped).toBeErrorInfo({
      message: 'unable to read the channel; fetch failed',
      code: ErrorCode.InternalError,
      statusCode: 500,
    });
    expect(wrapped.cause).toBeUndefined();
  });
});

describe('responseText', () => {
  it('returns the body of a short response', async () => {
    expect(await responseText(new Response('thread is busy', { status: 409 }))).toBe('thread is busy');
  });

  it('cuts a long body to its first 200 characters', async () => {
    const text = await responseText(new Response('x'.repeat(300), { status: 500 }));

    expect(text).toBe(`${'x'.repeat(200)}…`);
  });

  it('keeps a body of exactly 200 characters whole', async () => {
    expect(await responseText(new Response('x'.repeat(200), { status: 500 }))).toBe('x'.repeat(200));
  });

  it('returns the status text when the body is empty', async () => {
    expect(await responseText(new Response('', { status: 503, statusText: 'Service Unavailable' }))).toBe(
      'Service Unavailable',
    );
  });

  it('returns the status text when the body cannot be read', async () => {
    const response = new Response('ignored', { status: 502, statusText: 'Bad Gateway' });
    await response.text();

    expect(await responseText(response)).toBe('Bad Gateway');
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
