import { describe, expect, it } from 'vitest';

import type { Invocation as InvocationType, InvocationData } from '../../../src/core/invocation/index.js';
import { Invocation } from '../../../src/core/invocation/index.js';
import { ErrorCode } from '../../../src/errors.js';

describe('Invocation', () => {
  describe('fromJSON', () => {
    it('rehydrates the required fields', () => {
      const inv = Invocation.fromJSON({ sessionName: 's-1', runId: 'r-1' });

      expect(inv.sessionName).toBe('s-1');
      expect(inv.runId).toBe('r-1');
      expect(inv.stepId).toBeUndefined();
      expect(inv.messageId).toBeUndefined();
    });

    it('rehydrates optional stepId and messageId when present', () => {
      const inv = Invocation.fromJSON({
        sessionName: 's-1',
        runId: 'r-1',
        stepId: 'step-1',
        messageId: 'msg-1',
      });

      expect(inv.stepId).toBe('step-1');
      expect(inv.messageId).toBe('msg-1');
    });

    it('round-trips: fromJSON(toJSON(x)) preserves all fields', () => {
      const original: InvocationData = {
        sessionName: 's-1',
        runId: 'r-1',
        stepId: 'step-1',
        messageId: 'msg-1',
      };
      const inv = Invocation.fromJSON(original);

      const json = inv.toJSON();
      const rehydrated = Invocation.fromJSON(json);

      expect(rehydrated.sessionName).toBe(original.sessionName);
      expect(rehydrated.runId).toBe(original.runId);
      expect(rehydrated.stepId).toBe(original.stepId);
      expect(rehydrated.messageId).toBe(original.messageId);
    });

    it('toJSON() omits absent optional fields rather than emitting undefined', () => {
      const inv = Invocation.fromJSON({ sessionName: 's-1', runId: 'r-1' });
      const json = inv.toJSON();

      expect(Object.keys(json)).toEqual(['sessionName', 'runId']);
    });

    it('toJSON() returns a fresh object on each call so callers can mutate safely', () => {
      const inv = Invocation.fromJSON({ sessionName: 's-1', runId: 'r-1' });

      expect(inv.toJSON()).not.toBe(inv.toJSON());
    });

    it('rejects null with InvocationInvalid', () => {
      // Use JSON.parse('null') to obtain a real `null` without the literal,
      // which our lint config disallows project-wide.
      const nullValue = JSON.parse('null') as unknown as InvocationData;
      expect(() => Invocation.fromJSON(nullValue)).toThrowErrorInfoWithCode(ErrorCode.InvocationInvalid);
    });

    it('rejects an array (typeof "object" but not a plain object)', () => {
      expect(() => Invocation.fromJSON([] as unknown as InvocationData)).toThrowErrorInfoWithCode(
        ErrorCode.InvocationInvalid,
      );
    });

    it('rejects a non-object primitive', () => {
      expect(() => Invocation.fromJSON('not-data' as unknown as InvocationData)).toThrowErrorInfoWithCode(
        ErrorCode.InvocationInvalid,
      );
    });

    it('rejects missing sessionName', () => {
      expect(() => Invocation.fromJSON({ runId: 'r-1' } as unknown as InvocationData)).toThrowErrorInfoWithCode(
        ErrorCode.InvocationInvalid,
      );
    });

    it('rejects empty-string sessionName', () => {
      expect(() => Invocation.fromJSON({ sessionName: '', runId: 'r-1' })).toThrowErrorInfoWithCode(
        ErrorCode.InvocationInvalid,
      );
    });

    it('rejects wrong-typed sessionName', () => {
      expect(() =>
        Invocation.fromJSON({ sessionName: 42 as unknown as string, runId: 'r-1' }),
      ).toThrowErrorInfoWithCode(ErrorCode.InvocationInvalid);
    });

    it('rejects missing runId', () => {
      expect(() => Invocation.fromJSON({ sessionName: 's-1' } as unknown as InvocationData)).toThrowErrorInfoWithCode(
        ErrorCode.InvocationInvalid,
      );
    });

    it('rejects empty-string runId', () => {
      expect(() => Invocation.fromJSON({ sessionName: 's-1', runId: '' })).toThrowErrorInfoWithCode(
        ErrorCode.InvocationInvalid,
      );
    });

    it('rejects wrong-typed stepId when present', () => {
      expect(() =>
        Invocation.fromJSON({
          sessionName: 's-1',
          runId: 'r-1',
          stepId: 42 as unknown as string,
        }),
      ).toThrowErrorInfoWithCode(ErrorCode.InvocationInvalid);
    });

    it('rejects empty-string stepId when present', () => {
      expect(() => Invocation.fromJSON({ sessionName: 's-1', runId: 'r-1', stepId: '' })).toThrowErrorInfoWithCode(
        ErrorCode.InvocationInvalid,
      );
    });

    it('rejects wrong-typed messageId when present', () => {
      expect(() =>
        Invocation.fromJSON({
          sessionName: 's-1',
          runId: 'r-1',
          messageId: 42 as unknown as string,
        }),
      ).toThrowErrorInfoWithCode(ErrorCode.InvocationInvalid);
    });

    it('Invocation type can be referenced as a type and a value at the same name', () => {
      // Compile-time documentation: declaration merging means `Invocation`
      // is usable as both a type (`: InvocationType`) and a value
      // (`Invocation.fromJSON`).
      const inv: InvocationType = Invocation.fromJSON({ sessionName: 's', runId: 'r' });
      expect(inv.sessionName).toBe('s');
    });
  });
});
