/**
 * Unit tests for the pure reconstruction helpers in load-conversation.ts.
 *
 * loadRunProjection and loadConversation are exercised end-to-end by the
 * agent-session suite (they need a channel + run); these tests pin the pure
 * building blocks: history/live dedup-and-sort, and the per-node folds that
 * filter wires by run-id / codec-message-id and skip lifecycle events.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { EVENT_RUN_END, EVENT_RUN_START, HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../../src/constants.js';
import type { Codec, CodecInputEvent, Decoder } from '../../../src/core/codec/types.js';
import { foldInputMessages, foldRunMessages, withLiveMessages } from '../../../src/core/transport/load-conversation.js';

// ---------------------------------------------------------------------------
// Test codec — records the reducer routing key (codec-message-id) per fold, so
// getMessages reflects exactly which wires were folded and in what order.
// ---------------------------------------------------------------------------

interface TestInput extends CodecInputEvent {
  kind: 'in';
}
interface TestOutput {
  type: 'out';
}
interface TestMessage {
  id: string;
}
interface TestProjection {
  ids: string[];
}

const testCodec: Codec<TestInput, TestOutput, TestProjection, TestMessage> = {
  init: () => ({ ids: [] }),
  fold: (state, _event, meta) => ({ ids: [...state.ids, meta.messageId ?? ''] }),
  getMessages: (state) => state.ids.map((id) => ({ codecMessageId: id, message: { id } })),
  createDecoder: (): Decoder<TestInput, TestOutput> => ({ decode: () => ({ inputs: [], outputs: [{ type: 'out' }] }) }),
  createEncoder: () => {
    throw new Error('not used');
  },
  createUserMessage: (message: TestMessage) => ({ kind: 'user-message' as const, message }),
  createRegenerate: (target: string, parent: string) => ({ kind: 'regenerate', target, parent }) as const,
};

const msg = (opts: { name?: string; headers?: Record<string, string>; serial?: string }): Ably.InboundMessage =>
  ({
    name: opts.name ?? 'msg',
    action: 'message.create',
    extras: { ai: { transport: opts.headers ?? {} } },
    serial: opts.serial,
  }) as unknown as Ably.InboundMessage;

const serialsOf = (msgs: readonly Ably.InboundMessage[]): (string | undefined)[] => msgs.map((m) => m.serial);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withLiveMessages', () => {
  it('dedups by serial (history wins) and sorts chronologically', () => {
    const history = [msg({ serial: 's3' }), msg({ serial: 's1' })];
    const live = [msg({ serial: 's1' }), msg({ serial: 's2' })];
    expect(serialsOf(withLiveMessages(history, live))).toEqual(['s1', 's2', 's3']);
  });

  it('drops messages without a serial', () => {
    const history = [msg({ serial: 's1' }), msg({})];
    expect(serialsOf(withLiveMessages(history))).toEqual(['s1']);
  });

  it('handles undefined live messages', () => {
    const history = [msg({ serial: 's2' }), msg({ serial: 's1' })];
    expect(serialsOf(withLiveMessages(history))).toEqual(['s1', 's2']);
  });
});

describe('foldRunMessages', () => {
  it('folds only wires stamped with the given run-id', () => {
    const sorted = [
      msg({ headers: { [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'a' }, serial: 's1' }),
      msg({ headers: { [HEADER_RUN_ID]: 'R2', [HEADER_CODEC_MESSAGE_ID]: 'b' }, serial: 's2' }),
      msg({ headers: { [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'c' }, serial: 's3' }),
    ];
    const { projection, folded } = foldRunMessages(testCodec, sorted, 'R1');
    expect(folded).toBe(2);
    expect(testCodec.getMessages(projection).map((m) => m.message.id)).toEqual(['a', 'c']);
  });

  it('skips run-lifecycle events even when stamped with the run-id', () => {
    const sorted = [
      msg({ name: EVENT_RUN_START, headers: { [HEADER_RUN_ID]: 'R1' }, serial: 's1' }),
      msg({ headers: { [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'a' }, serial: 's2' }),
      msg({ name: EVENT_RUN_END, headers: { [HEADER_RUN_ID]: 'R1' }, serial: 's3' }),
    ];
    const { projection, folded } = foldRunMessages(testCodec, sorted, 'R1');
    expect(folded).toBe(1);
    expect(testCodec.getMessages(projection).map((m) => m.message.id)).toEqual(['a']);
  });

  it('stops before the truncateAt codec-message-id (exclusive)', () => {
    const sorted = [
      msg({ headers: { [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'a' }, serial: 's1' }),
      msg({ headers: { [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'b' }, serial: 's2' }),
      msg({ headers: { [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'c' }, serial: 's3' }),
    ];
    const { projection, folded } = foldRunMessages(testCodec, sorted, 'R1', 'b');
    expect(folded).toBe(1);
    expect(testCodec.getMessages(projection).map((m) => m.message.id)).toEqual(['a']);
  });
});

describe('foldInputMessages', () => {
  it('folds only run-less wires matching the codec-message-id', () => {
    const sorted = [
      msg({ headers: { [HEADER_CODEC_MESSAGE_ID]: 'u1' }, serial: 's1' }),
      // Same codec-message-id but run-bearing — belongs to a reply run, not the input node.
      msg({ headers: { [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'u1' }, serial: 's2' }),
      // Different input node.
      msg({ headers: { [HEADER_CODEC_MESSAGE_ID]: 'u2' }, serial: 's3' }),
      // An amend on the same input node folds in too.
      msg({ headers: { [HEADER_CODEC_MESSAGE_ID]: 'u1' }, serial: 's4' }),
    ];
    const projection = foldInputMessages(testCodec, sorted, 'u1');
    expect(testCodec.getMessages(projection).map((m) => m.message.id)).toEqual(['u1', 'u1']);
  });
});
