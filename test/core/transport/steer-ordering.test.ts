import { describe, expect, it } from 'vitest';

import type { CodecMessage } from '../../../src/core/codec/types.js';
import { deferUnrespondedSteers } from '../../../src/core/transport/steer-ordering.js';

const msg = (codecMessageId: string): CodecMessage<string> => ({ codecMessageId, message: codecMessageId });

const ids = (messages: CodecMessage<string>[]): string[] => messages.map((m) => m.codecMessageId);

describe('deferUnrespondedSteers', () => {
  it('moves an unresponded steer sitting before the assistant output to the tail', () => {
    // Raw serial order: user prompt, unresponded steer, assistant output.
    const messages = [msg('foo'), msg('bar'), msg('assistant')];
    const out = deferUnrespondedSteers(messages, (cmid) => cmid === 'bar');
    expect(ids(out)).toEqual(['foo', 'assistant', 'bar']);
  });

  it('returns the same array reference when no message is an unresponded steer', () => {
    const messages = [msg('foo'), msg('bar'), msg('assistant')];
    const out = deferUnrespondedSteers(messages, () => false);
    expect(out).toBe(messages);
  });

  it('leaves a responded steer in its serial position', () => {
    // "bar" was responded to, so the predicate excludes it — no reorder.
    const messages = [msg('foo'), msg('bar'), msg('assistant')];
    const out = deferUnrespondedSteers(messages, () => false);
    expect(ids(out)).toEqual(['foo', 'bar', 'assistant']);
  });

  it('preserves the relative order of multiple unresponded steers', () => {
    const messages = [msg('foo'), msg('s1'), msg('assistant'), msg('s2')];
    const out = deferUnrespondedSteers(messages, (cmid) => cmid === 's1' || cmid === 's2');
    expect(ids(out)).toEqual(['foo', 'assistant', 's1', 's2']);
  });

  it('is a no-op on an empty message list', () => {
    const messages: CodecMessage<string>[] = [];
    const out = deferUnrespondedSteers(messages, () => true);
    expect(out).toBe(messages);
  });
});
