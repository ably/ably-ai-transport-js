import type * as Ably from 'ably';
import { describe, expect,it } from 'vitest';

import { DOMAIN_HEADER_PREFIX as D } from '../src/constants.js';
import { getHeaders, headerReader, headerWriter, mergeHeaders, parseBool, parseJson, setHeadersIfPresent, setIfPresent, stripUndefined } from '../src/utils.js';

describe('getHeaders', () => {
  it('extracts headers from a well-formed message', () => {
    const msg = { extras: { headers: { 'x-key': 'value' } } } as Ably.InboundMessage;
    expect(getHeaders(msg)).toEqual({ 'x-key': 'value' });
  });

  it('returns empty object when extras is undefined', () => {
    const msg = { extras: undefined } as Ably.InboundMessage;
    expect(getHeaders(msg)).toEqual({});
  });

  it('returns empty object when extras is falsy', () => {
    // CAST: testing runtime guard against falsy extras values
    const msg = { extras: 0 } as unknown as Ably.InboundMessage;
    expect(getHeaders(msg)).toEqual({});
  });

  it('returns empty object when headers is missing', () => {
    const msg = { extras: {} } as Ably.InboundMessage;
    expect(getHeaders(msg)).toEqual({});
  });

  it('returns empty object when extras is not an object', () => {
    const msg = { extras: 'string' } as Ably.InboundMessage;
    expect(getHeaders(msg)).toEqual({});
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

describe('setIfPresent', () => {
  it('sets a string value', () => {
    const h: Record<string, string> = {};
    setIfPresent(h, 'key', 'value');
    expect(h).toEqual({ key: 'value' });
  });

  it('sets a boolean value as string', () => {
    const h: Record<string, string> = {};
    setIfPresent(h, 'flag', true);
    expect(h).toEqual({ flag: 'true' });
  });

  it('sets an object as JSON', () => {
    const h: Record<string, string> = {};
    setIfPresent(h, 'obj', { a: 1 });
    expect(h).toEqual({ obj: '{"a":1}' });
  });

  it('skips undefined', () => {
    const h: Record<string, string> = {};
    setIfPresent(h, 'key', undefined);
    expect(h).toEqual({});
  });

  it('sets a number as string', () => {
    const h: Record<string, string> = {};
    setIfPresent(h, 'num', 42);
    expect(h).toEqual({ num: '42' });
  });
});

describe('setHeadersIfPresent', () => {
  it('sets multiple headers at once', () => {
    const h: Record<string, string> = {};
    setHeadersIfPresent(h, { a: 'one', b: 2, c: true });
    expect(h).toEqual({ a: 'one', b: '2', c: 'true' });
  });

  it('skips undefined and null entries', () => {
    const h: Record<string, string> = { existing: 'keep' };
    // eslint-disable-next-line unicorn/no-null -- testing null handling
    setHeadersIfPresent(h, { a: 'set', b: undefined, c: null });
    expect(h).toEqual({ existing: 'keep', a: 'set' });
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

describe('headerReader', () => {
  const headers = {
    [`${D}toolCallId`]: 'tc-1',
    [`${D}dynamic`]: 'true',
    [`${D}providerExecuted`]: 'false',
    [`${D}providerMetadata`]: '{"anthropic":{"cacheControl":"ephemeral"}}',
  };

  it('reads string values with str()', () => {
    const r = headerReader(headers);
    expect(r.str('toolCallId')).toBe('tc-1');
    expect(r.str('missing')).toBeUndefined();
  });

  it('reads string values with fallback via strOr()', () => {
    const r = headerReader(headers);
    expect(r.strOr('toolCallId', '')).toBe('tc-1');
    expect(r.strOr('missing', 'default')).toBe('default');
  });

  it('reads boolean values with bool()', () => {
    const r = headerReader(headers);
    expect(r.bool('dynamic')).toBe(true);
    expect(r.bool('providerExecuted')).toBe(false);
    expect(r.bool('missing')).toBeUndefined();
  });

  it('reads JSON values with json()', () => {
    const r = headerReader(headers);
    expect(r.json('providerMetadata')).toEqual({ anthropic: { cacheControl: 'ephemeral' } });
    expect(r.json('missing')).toBeUndefined();
  });

});

describe('headerWriter', () => {
  it('writes string values with str()', () => {
    const h = headerWriter().str('toolCallId', 'tc-1').build();
    expect(h).toEqual({ [`${D}toolCallId`]: 'tc-1' });
  });

  it('skips undefined string values', () => {
    const title: string | undefined = undefined;
    const h = headerWriter().str('toolCallId', 'tc-1').str('title', title).build();
    expect(h).toEqual({ [`${D}toolCallId`]: 'tc-1' });
  });

  it('writes boolean values with bool()', () => {
    const h = headerWriter().bool('dynamic', true).bool('providerExecuted', false).build();
    expect(h).toEqual({ [`${D}dynamic`]: 'true', [`${D}providerExecuted`]: 'false' });
  });

  it('skips undefined boolean values', () => {
    const dynamic: boolean | undefined = undefined;
    const h = headerWriter().bool('dynamic', dynamic).build();
    expect(h).toEqual({});
  });

  it('writes JSON values with json()', () => {
    const h = headerWriter().json('providerMetadata', { anthropic: { key: 'val' } }).build();
    expect(h).toEqual({ [`${D}providerMetadata`]: '{"anthropic":{"key":"val"}}' });
  });

  it('skips undefined and null JSON values', () => {
    const absent: unknown = undefined;
    // eslint-disable-next-line unicorn/no-null -- testing null handling
    const h = headerWriter().json('a', absent).json('b', null).build();
    expect(h).toEqual({});
  });

  it('supports fluent chaining', () => {
    const h = headerWriter()
      .str('toolCallId', 'tc-1')
      .str('toolName', 'search')
      .bool('dynamic', true)
      .json('providerMetadata', { k: 'v' })
      .build();
    expect(h).toEqual({
      [`${D}toolCallId`]: 'tc-1',
      [`${D}toolName`]: 'search',
      [`${D}dynamic`]: 'true',
      [`${D}providerMetadata`]: '{"k":"v"}',
    });
  });

  it('produces headers readable by headerReader', () => {
    const h = headerWriter()
      .str('toolCallId', 'tc-1')
      .bool('dynamic', true)
      .json('providerMetadata', { k: 'v' })
      .build();
    const r = headerReader(h);
    expect(r.str('toolCallId')).toBe('tc-1');
    expect(r.bool('dynamic')).toBe(true);
    expect(r.json('providerMetadata')).toEqual({ k: 'v' });
  });
});
