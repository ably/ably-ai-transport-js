import { describe, expect, it } from 'vitest';

import { headerReader, headerWriter } from '../../../src/core/codec/index.js';

// Helpers exist at module scope so the lint rule sees them as static; their
// dynamic return type lets the writer's setter overloads accept undefined
// without the explicit-undefined unicorn lint rule firing.
const undefString = (): string | undefined => undefined;
const undefBool = (): boolean | undefined => undefined;

describe('domain headers', () => {
  describe('headerWriter', () => {
    it('prefixes string keys and skips undefined values', () => {
      const headers = headerWriter().str('messageId', 'm-1').str('skipped', undefString()).build();

      expect(headers).toEqual({ 'x-domain-messageId': 'm-1' });
    });

    it('serialises booleans as "true"/"false"', () => {
      const headers = headerWriter().bool('flag', true).bool('off', false).bool('omit', undefBool()).build();

      expect(headers).toEqual({ 'x-domain-flag': 'true', 'x-domain-off': 'false' });
    });

    it('serialises objects as JSON and skips undefined/null', () => {
      const headers = headerWriter().json('payload', { a: 1 }).json('omit-undefined', undefString()).build();

      expect(headers).toEqual({ 'x-domain-payload': '{"a":1}' });
    });

    it('chains', () => {
      const headers = headerWriter().str('a', '1').bool('b', true).json('c', [1, 2]).build();

      expect(headers).toEqual({
        'x-domain-a': '1',
        'x-domain-b': 'true',
        'x-domain-c': '[1,2]',
      });
    });
  });

  describe('headerReader', () => {
    const source = {
      'x-domain-messageId': 'm-1',
      'x-domain-flag': 'true',
      'x-domain-payload': '{"a":1}',
      'x-domain-bad-json': 'not-json',
      other: 'no-prefix',
    };

    it('reads strings with optional fallback', () => {
      const reader = headerReader(source);
      expect(reader.str('messageId')).toBe('m-1');
      expect(reader.str('missing')).toBeUndefined();
      expect(reader.strOr('missing', 'default')).toBe('default');
    });

    it('parses booleans', () => {
      const reader = headerReader(source);
      expect(reader.bool('flag')).toBe(true);
      expect(reader.bool('messageId')).toBe(false); // any non-"true" string parses as false
      expect(reader.bool('missing')).toBeUndefined();
    });

    it('parses JSON, returning undefined on bad input', () => {
      const reader = headerReader(source);
      expect(reader.json('payload')).toEqual({ a: 1 });
      expect(reader.json('bad-json')).toBeUndefined();
      expect(reader.json('missing')).toBeUndefined();
    });
  });
});
