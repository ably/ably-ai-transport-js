import type * as Ably from 'ably';
import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import { createEncoderCore } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createEncoder } from '../../../src/vercel/codec/encoder.js';
import { createMockChannel } from '../../helper/mock-realtime.js';

const makeEncoder = () => {
  const channel = createMockChannel();
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const core = createEncoderCore(channel, { logger });
  const encoder = createEncoder({ core, logger });
  return { encoder, channel };
};

const headersOf = (message: Ably.Message): Record<string, string> => {
  // CAST: tests own the structure of `extras` they passed in.
  const extras = message.extras as { headers?: Record<string, string> } | undefined;
  return extras?.headers ?? {};
};

describe('UIMessageCodec encoder', () => {
  describe('encodePart', () => {
    it('text-start opens a stream with x-ably-stream:true and the codec id header', async () => {
      const { encoder, channel } = makeEncoder();

      await encoder.encodePart(
        { type: 'text-start', id: 'p-1' },
        { headers: { [Headers.MessageId]: 'm-1', [Headers.RunId]: 'r-1' } },
      );

      const [wire] = channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected one wire');
      expect(wire.name).toBe('text');
      const headers = headersOf(wire);
      expect(headers[Headers.Stream]).toBe('true');
      expect(headers[Headers.Status]).toBe('streaming');
      expect(headers[Headers.StreamId]).toBe('p-1');
      expect(headers[Headers.MessageId]).toBe('m-1');
      expect(headers['x-domain-id']).toBe('p-1');
    });

    it('text-delta calls appendMessage against the captured serial', async () => {
      const { encoder, channel } = makeEncoder();
      await encoder.encodePart({ type: 'text-start', id: 'p-1' }, { headers: { [Headers.MessageId]: 'm-1' } });

      await encoder.encodePart({ type: 'text-delta', id: 'p-1', delta: 'hello' });

      // appendStream is fire-and-forget — let microtasks settle.
      await Promise.resolve();
      expect(channel.appendedMessages).toHaveLength(1);
      const append = channel.appendedMessages[0];
      if (!append) throw new Error('expected an append');
      expect(append.data).toBe('hello');
    });

    it('text-end closes the stream with x-ably-status:finished', async () => {
      const { encoder, channel } = makeEncoder();
      await encoder.encodePart({ type: 'text-start', id: 'p-1' }, { headers: { [Headers.MessageId]: 'm-1' } });
      await encoder.encodePart({ type: 'text-delta', id: 'p-1', delta: 'hello' });

      await encoder.encodePart({ type: 'text-end', id: 'p-1' });

      // The closing append is the last one recorded.
      const closing = channel.appendedMessages.at(-1);
      if (!closing) throw new Error('expected a closing append');
      expect(headersOf(closing)[Headers.Status]).toBe('finished');
    });

    it('silently drops out-of-scope chunks (e.g. tool-input-start)', async () => {
      const { encoder, channel } = makeEncoder();

      await encoder.encodePart({
        type: 'tool-input-start',
        toolCallId: 't-1',
        toolName: 'doThing',
      });

      expect(channel.publish).not.toHaveBeenCalled();
      expect(channel.appendedMessages).toHaveLength(0);
    });

    it('silently drops lifecycle chunks (start, finish-step, etc.)', async () => {
      const { encoder, channel } = makeEncoder();

      await encoder.encodePart({ type: 'start' });
      await encoder.encodePart({ type: 'finish-step' });
      await encoder.encodePart({ type: 'finish' });

      expect(channel.publish).not.toHaveBeenCalled();
    });
  });

  describe('encodeMessage', () => {
    it('publishes one batch carrying one wire per text part with x-domain-messageId', async () => {
      const { encoder, channel } = makeEncoder();
      const message: AI.UIMessage = {
        id: 'msg-X',
        role: 'user',
        parts: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      };

      await encoder.encodeMessage(message, { headers: { [Headers.MessageId]: 'm-1', [Headers.RunId]: 'r-1' } });

      expect(channel.publish).toHaveBeenCalledTimes(1);
      const batch = channel.publishedBatches[0] ?? [];
      expect(batch).toHaveLength(2);
      // CAST: Ably.Message.data is typed any; this test produced strings.
      expect(batch.map((m) => m.data as string)).toEqual(['first', 'second']);
      for (const wire of batch) {
        expect(wire.name).toBe('text');
        const headers = headersOf(wire);
        expect(headers[Headers.MessageId]).toBe('m-1');
        expect(headers[Headers.RunId]).toBe('r-1');
        expect(headers[Headers.Discrete]).toBe('true');
        expect(headers['x-domain-messageId']).toBe('msg-X');
      }
    });

    it('only publishes through publishBatch — no appendMessage/updateMessage', async () => {
      const { encoder, channel } = makeEncoder();
      const message: AI.UIMessage = {
        id: 'msg-X',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      };

      await encoder.encodeMessage(message, { headers: { [Headers.MessageId]: 'm-1' } });

      expect(channel.appendMessage).not.toHaveBeenCalled();
      expect(channel.updateMessage).not.toHaveBeenCalled();
    });

    it('emits a single empty text wire as the defensive fallback when there are no encodable parts', async () => {
      const { encoder, channel } = makeEncoder();
      const message: AI.UIMessage = {
        id: 'msg-X',
        role: 'user',
        // Non-text parts are silently dropped per the phase 8 scope; the
        // codec still emits a single empty text create so the writer's
        // lastMessageId accounting has a wire to attribute to.
        parts: [{ type: 'reasoning', text: 'thinking' }],
      };

      await encoder.encodeMessage(message, { headers: { [Headers.MessageId]: 'm-1' } });

      const batch = channel.publishedBatches[0] ?? [];
      expect(batch).toHaveLength(1);
      const [wire] = batch;
      if (!wire) throw new Error('expected one wire');
      expect(wire.name).toBe('text');
      expect(wire.data).toBe('');
      expect(headersOf(wire)['x-domain-messageId']).toBe('msg-X');
    });
  });

  describe('encodeEvent', () => {
    it('rejects with an Ably.ErrorInfo carrying InvalidArgument', async () => {
      const { encoder } = makeEncoder();
      // CAST: stub event for the not-supported path; the codec rejects before reading it.
      await expect(encoder.encodeEvent({} as unknown as AI.ToolModelMessage)).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });
  });

  describe('close', () => {
    it('delegates to core.close — auto-aborts open streams', async () => {
      const { encoder, channel } = makeEncoder();
      await encoder.encodePart({ type: 'text-start', id: 'p-1' }, { headers: { [Headers.MessageId]: 'm-1' } });

      await encoder.close();

      const aborted = channel.appendedMessages.at(-1);
      if (!aborted) throw new Error('expected an aborted close-append');
      expect(headersOf(aborted)[Headers.Status]).toBe('aborted');
    });
  });
});
