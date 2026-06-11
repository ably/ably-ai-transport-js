import { describe, expect, expectTypeOf, it } from 'vitest';

import type { FieldFor } from '../../../src/core/codec/fields.js';
import { boolField, enumField, jsonField, strField } from '../../../src/core/codec/fields.js';

describe('header-field bindings', () => {
  describe('strField', () => {
    it('round-trips a value through write then read', () => {
      const f = strField('id');
      const h: Record<string, string> = {};
      f.write(h, 'msg-1');
      expect(h).toEqual({ id: 'msg-1' });
      expect(f.read(h)).toBe('msg-1');
    });

    it('reads undefined when the header is absent (no default)', () => {
      const f = strField('id');
      expect(f.read({})).toBeUndefined();
    });

    it('reads the fallback when the header is absent (defaulted)', () => {
      const f = strField('toolName', '');
      expect(f.read({})).toBe('');
      expect(strField('toolName', 'fallback').read({})).toBe('fallback');
    });

    it('reads a present empty string as the empty string, not the fallback', () => {
      const f = strField('toolName', 'fallback');
      expect(f.read({ toolName: '' })).toBe('');
    });

    it('write skips an undefined value, leaving the key unset', () => {
      const f = strField('id');
      const h: Record<string, string> = {};
      const absent = f.read({}); // undefined — read of an absent header
      f.write(h, absent);
      expect(h).toEqual({});
      expect('id' in h).toBe(false);
    });

    it('exposes the bound key', () => {
      expect(strField('toolCallId').key).toBe('toolCallId');
    });

    it('a defaulted field reads as a total string (type check)', () => {
      const f = strField('toolName', '');
      // Assignable to string without narrowing — fails typecheck if the
      // defaulted overload regresses to `string | undefined`.
      const value: string = f.read({});
      expect(value).toBe('');
    });
  });

  describe('boolField', () => {
    it('round-trips true and false', () => {
      const f = boolField('dynamic');
      const hTrue: Record<string, string> = {};
      f.write(hTrue, true);
      expect(hTrue).toEqual({ dynamic: 'true' });
      expect(f.read(hTrue)).toBe(true);

      const hFalse: Record<string, string> = {};
      f.write(hFalse, false);
      expect(hFalse).toEqual({ dynamic: 'false' });
      expect(f.read(hFalse)).toBe(false);
    });

    it('reads undefined when absent (no default)', () => {
      expect(boolField('dynamic').read({})).toBeUndefined();
    });

    it('reads the fallback when absent (defaulted)', () => {
      expect(boolField('dynamic', false).read({})).toBe(false);
      expect(boolField('dynamic', true).read({})).toBe(true);
    });

    it('reads any non-"true" present value as false', () => {
      const f = boolField('dynamic');
      expect(f.read({ dynamic: 'false' })).toBe(false);
      expect(f.read({ dynamic: 'yes' })).toBe(false);
    });

    it('write skips an undefined value', () => {
      const f = boolField('dynamic');
      const h: Record<string, string> = {};
      const absent = f.read({}); // undefined — read of an absent header
      f.write(h, absent);
      expect(h).toEqual({});
    });

    it('a defaulted field reads as a total boolean (type check)', () => {
      const value: boolean = boolField('dynamic', false).read({});
      expect(value).toBe(false);
    });
  });

  describe('jsonField', () => {
    interface Meta {
      provider: string;
      score: number;
    }

    it('round-trips a structured value', () => {
      const f = jsonField<Meta>('providerMetadata');
      const h: Record<string, string> = {};
      f.write(h, { provider: 'acme', score: 7 });
      expect(h.providerMetadata).toBe('{"provider":"acme","score":7}');
      expect(f.read(h)).toEqual({ provider: 'acme', score: 7 });
    });

    it('reads undefined when absent', () => {
      expect(jsonField<Meta>('providerMetadata').read({})).toBeUndefined();
    });

    it('reads undefined on malformed JSON', () => {
      const f = jsonField<Meta>('providerMetadata');
      expect(f.read({ providerMetadata: '{not json' })).toBeUndefined();
    });

    it('write skips an undefined value', () => {
      const f = jsonField<Meta>('providerMetadata');
      const h: Record<string, string> = {};
      const absent = f.read({}); // undefined — read of an absent header
      f.write(h, absent);
      expect(h).toEqual({});
    });
  });

  describe('enumField', () => {
    // The AI.FinishReason members — a representative validated-enum field.
    const finishReasons = ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other'] as const;

    it('round-trips every allowed value', () => {
      const f = enumField('finishReason', finishReasons, 'stop');
      for (const reason of finishReasons) {
        const h: Record<string, string> = {};
        f.write(h, reason);
        expect(h).toEqual({ finishReason: reason });
        expect(f.read(h)).toBe(reason);
      }
    });

    it('reads the fallback when the header is absent', () => {
      expect(enumField('finishReason', finishReasons, 'stop').read({})).toBe('stop');
    });

    it('reads the fallback when the value is not in the allow-list', () => {
      const f = enumField('finishReason', finishReasons, 'stop');
      expect(f.read({ finishReason: 'made-up' })).toBe('stop');
    });

    it('write always sets the key (the field is total)', () => {
      const h: Record<string, string> = {};
      enumField('finishReason', finishReasons, 'stop').write(h, 'length');
      expect(h).toEqual({ finishReason: 'length' });
    });

    it('reads as the allowed union, total (type check)', () => {
      const value: (typeof finishReasons)[number] = enumField('finishReason', finishReasons, 'stop').read({});
      expect(value).toBe('stop');
    });
  });
  describe('FieldFor (type contract)', () => {
    interface Member {
      id: string;
      done?: boolean;
    }

    it('accepts fields whose key names a member property with a compatible value type', () => {
      expectTypeOf(strField('id')).toExtend<FieldFor<Member>>();
      expectTypeOf(boolField('done')).toExtend<FieldFor<Member>>();
      expectTypeOf(strField('id', '')).toExtend<FieldFor<Member>>();
    });

    it('rejects a mistyped key and a wrong-typed field', () => {
      // A typo'd key names no member property...
      expectTypeOf(strField('idd')).not.toExtend<FieldFor<Member>>();
      // ...and a boolean field cannot bind a string property.
      expectTypeOf(boolField('id')).not.toExtend<FieldFor<Member>>();
    });
  });
});
