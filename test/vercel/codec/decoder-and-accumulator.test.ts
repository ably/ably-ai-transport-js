import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { Headers } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createAccumulator } from '../../../src/vercel/codec/accumulator.js';
import { createDecoder } from '../../../src/vercel/codec/decoder.js';

interface InboundOverrides {
  action: 'message.create' | 'message.append' | 'message.update' | 'message.delete';
  serial?: string;
  name?: string;
  data?: unknown;
  headers?: Record<string, string>;
}

const makeInbound = (overrides: InboundOverrides): Ably.InboundMessage =>
  ({
    id: `${overrides.action}:${overrides.serial ?? ''}`,
    serial: overrides.serial,
    timestamp: Date.now(),
    action: overrides.action,
    version: { serial: overrides.serial ?? '', timestamp: Date.now() },
    annotations: {},
    name: overrides.name ?? 'text',
    data: overrides.data,
    extras: { headers: overrides.headers ?? {} },
  }) as unknown as Ably.InboundMessage;

const makeStack = () => {
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const decoder = createDecoder(logger);
  const accumulator = createAccumulator(logger);
  // Drive the values through the same path the session does — call
  // the right accumulator method based on the value kind.
  const feed = (message: Ably.InboundMessage): void => {
    for (const value of decoder.decode(message)) {
      if (value.messageId === undefined) continue;
      if (value.kind === 'part') {
        accumulator.processPart(value.part, value.messageId);
      } else if (value.kind === 'message') {
        accumulator.applyMessage(value.messageId, value.message);
      }
    }
  };
  return { decoder, accumulator, feed };
};

describe('UIMessageCodec decoder + accumulator', () => {
  describe('streaming text round-trip', () => {
    it('builds a single UIMessage with the concatenated text from text-start/delta/end', () => {
      const { accumulator, feed } = makeStack();

      // Real Ably appends carry persistent headers from the create — the
      // encoder core repeats them on every appendMessage. Mirror that
      // here so x-ably-msg-id correlation works for the deltas.
      const persistentHeaders = {
        [Headers.Stream]: 'true',
        [Headers.StreamId]: 'p-1',
        [Headers.MessageId]: 'wire-1',
      };
      feed(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          data: '',
          headers: { ...persistentHeaders, [Headers.Status]: 'streaming' },
        }),
      );
      feed(makeInbound({ action: 'message.append', serial: '01', data: 'hello', headers: persistentHeaders }));
      feed(makeInbound({ action: 'message.append', serial: '01', data: ' world', headers: persistentHeaders }));
      feed(
        makeInbound({
          action: 'message.append',
          serial: '01',
          data: '',
          headers: { ...persistentHeaders, [Headers.Status]: 'finished' },
        }),
      );

      const message = accumulator.getMessage('wire-1');
      expect(message).toBeDefined();
      expect(message?.id).toBe('wire-1');
      expect(message?.role).toBe('assistant');
      expect(message?.parts).toEqual([{ type: 'text', text: 'hello world' }]);
    });
  });

  describe('discrete text round-trip', () => {
    it('builds a UIMessage carrying the caller-supplied id and role from x-domain-messageId / x-ably-role', () => {
      const { accumulator, feed } = makeStack();

      feed(
        makeInbound({
          action: 'message.create',
          serial: '02',
          name: 'text',
          data: 'hi',
          headers: {
            [Headers.Stream]: 'false',
            [Headers.Discrete]: 'true',
            [Headers.MessageId]: 'wire-2',
            [Headers.Role]: 'user',
            'x-domain-messageId': 'msg-X',
          },
        }),
      );

      // The codec stamps the SDK routing id (`wire-2`) on the chunk
      // outputs; the accumulator stores the assembled message under that
      // key. The UIMessage.id is the caller-supplied one.
      const message = accumulator.getMessage('wire-2');
      expect(message).toBeDefined();
      expect(message?.id).toBe('msg-X');
      expect(message?.role).toBe('user');
      expect(message?.parts).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('appends each text wire under the same x-ably-msg-id as a distinct part', () => {
      const { accumulator, feed } = makeStack();

      // Two wires sharing one x-ably-msg-id (a multi-text-part UIMessage
      // published by encodeMessage) should yield two text parts.
      const baseHeaders = {
        [Headers.Stream]: 'false',
        [Headers.Discrete]: 'true',
        [Headers.MessageId]: 'wire-3',
        [Headers.Role]: 'user',
        'x-domain-messageId': 'msg-Y',
      };
      feed(makeInbound({ action: 'message.create', serial: '03', name: 'text', data: 'first', headers: baseHeaders }));
      feed(makeInbound({ action: 'message.create', serial: '04', name: 'text', data: 'second', headers: baseHeaders }));

      const message = accumulator.getMessage('wire-3');
      expect(message).toBeDefined();
      expect(message?.parts).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]);
      expect(message?.id).toBe('msg-Y');
    });
  });

  describe('out-of-scope wires', () => {
    it('ignores discrete wires whose name is not text', () => {
      const { accumulator, feed } = makeStack();

      feed(
        makeInbound({
          action: 'message.create',
          serial: '05',
          name: 'tool-input-start',
          data: '',
          headers: { [Headers.Stream]: 'false', [Headers.Discrete]: 'true', [Headers.MessageId]: 'wire-5' },
        }),
      );

      expect(accumulator.getMessage('wire-5')).toBeUndefined();
    });

    it('ignores text discrete wires that lack the x-ably-discrete marker (lifecycle echoes)', () => {
      const { accumulator, feed } = makeStack();

      feed(
        makeInbound({
          action: 'message.create',
          serial: '06',
          name: 'text',
          data: 'hi',
          headers: { [Headers.Stream]: 'false', [Headers.MessageId]: 'wire-6' },
        }),
      );

      expect(accumulator.getMessage('wire-6')).toBeUndefined();
    });

    it('ignores streamed wires whose name is not text', () => {
      const { accumulator, feed } = makeStack();

      feed(
        makeInbound({
          action: 'message.create',
          serial: '07',
          name: 'reasoning',
          data: '',
          headers: {
            [Headers.Stream]: 'true',
            [Headers.StreamId]: 'r-1',
            [Headers.MessageId]: 'wire-7',
            [Headers.Status]: 'streaming',
          },
        }),
      );

      expect(accumulator.getMessage('wire-7')).toBeUndefined();
    });
  });

  describe('setMessage / completeMessage', () => {
    it('setMessage replaces the assembled state', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '08',
          name: 'text',
          data: 'first',
          headers: {
            [Headers.Stream]: 'false',
            [Headers.Discrete]: 'true',
            [Headers.MessageId]: 'wire-8',
            [Headers.Role]: 'user',
            'x-domain-messageId': 'msg-A',
          },
        }),
      );

      accumulator.setMessage('wire-8', {
        id: 'msg-A',
        role: 'user',
        parts: [{ type: 'text', text: 'replacement' }],
      });

      expect(accumulator.getMessage('wire-8')?.parts).toEqual([{ type: 'text', text: 'replacement' }]);
    });

    it('completeMessage clears stream state but keeps the assembled message readable', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '09',
          name: 'text',
          data: 'hi',
          headers: {
            [Headers.Stream]: 'false',
            [Headers.Discrete]: 'true',
            [Headers.MessageId]: 'wire-9',
            [Headers.Role]: 'user',
            'x-domain-messageId': 'msg-B',
          },
        }),
      );

      accumulator.completeMessage('wire-9');

      expect(accumulator.getMessage('wire-9')?.parts).toEqual([{ type: 'text', text: 'hi' }]);
    });
  });

  describe('applyEvent', () => {
    it('throws Ably.ErrorInfo with InvalidArgument — events are deferred', () => {
      const { accumulator } = makeStack();
      // CAST: phase 8 has no real ToolModelMessage path; the throw fires before reading the value.
      expect(() => {
        accumulator.applyEvent({} as never, 'wire-Z');
      }).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });
});
