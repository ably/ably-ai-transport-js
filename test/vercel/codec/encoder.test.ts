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

    it('silently drops out-of-scope chunks (e.g. reasoning-start)', async () => {
      const { encoder, channel } = makeEncoder();

      await encoder.encodePart({ type: 'reasoning-start', id: 'r-1' });

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

    it('tool-input-start opens a tool-input stream keyed by toolCallId with toolName/dynamic/title headers', async () => {
      const { encoder, channel } = makeEncoder();

      await encoder.encodePart(
        { type: 'tool-input-start', toolCallId: 't-1', toolName: 'getWeather', dynamic: true, title: 'Get weather' },
        { headers: { [Headers.MessageId]: 'm-1' } },
      );

      const [wire] = channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected one wire');
      expect(wire.name).toBe('tool-input');
      const headers = headersOf(wire);
      expect(headers[Headers.Stream]).toBe('true');
      expect(headers[Headers.StreamId]).toBe('t-1');
      expect(headers[Headers.MessageId]).toBe('m-1');
      expect(headers['x-domain-toolName']).toBe('getWeather');
      expect(headers['x-domain-dynamic']).toBe('true');
      expect(headers['x-domain-title']).toBe('Get weather');
    });

    it('tool-input-delta appends the inputTextDelta to the tool-input stream', async () => {
      const { encoder, channel } = makeEncoder();
      await encoder.encodePart(
        { type: 'tool-input-start', toolCallId: 't-1', toolName: 'getWeather' },
        { headers: { [Headers.MessageId]: 'm-1' } },
      );

      await encoder.encodePart({ type: 'tool-input-delta', toolCallId: 't-1', inputTextDelta: '{"city":' });
      await encoder.encodePart({ type: 'tool-input-delta', toolCallId: 't-1', inputTextDelta: '"Paris"}' });

      // appendStream is fire-and-forget — let microtasks settle.
      await Promise.resolve();
      expect(channel.appendedMessages).toHaveLength(2);
      // CAST: Ably.Message.data is typed any; this test produced strings.
      expect(channel.appendedMessages.map((m) => m.data as string)).toEqual(['{"city":', '"Paris"}']);
    });

    it('tool-input-available closes the stream with finished status and the parsed input as a domain header', async () => {
      const { encoder, channel } = makeEncoder();
      await encoder.encodePart(
        { type: 'tool-input-start', toolCallId: 't-1', toolName: 'getWeather' },
        { headers: { [Headers.MessageId]: 'm-1' } },
      );

      await encoder.encodePart({
        type: 'tool-input-available',
        toolCallId: 't-1',
        toolName: 'getWeather',
        input: { city: 'Paris' },
      });

      const closing = channel.appendedMessages.at(-1);
      if (!closing) throw new Error('expected a closing append');
      const headers = headersOf(closing);
      expect(headers[Headers.Status]).toBe('finished');
      expect(headers['x-domain-input']).toBe(JSON.stringify({ city: 'Paris' }));
      expect(headers['x-domain-toolName']).toBe('getWeather');
    });

    it('tool-output-available publishes a discrete tool-output-available wire with the output as data', async () => {
      const { encoder, channel } = makeEncoder();

      await encoder.encodePart(
        {
          type: 'tool-output-available',
          toolCallId: 't-1',
          output: { temperature: 22, units: 'celsius' },
        },
        { headers: { [Headers.MessageId]: 'm-1' } },
      );

      const [wire] = channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected one wire');
      expect(wire.name).toBe('tool-output-available');
      expect(wire.data).toEqual({ temperature: 22, units: 'celsius' });
      const headers = headersOf(wire);
      expect(headers[Headers.Stream]).toBe('false');
      expect(headers[Headers.MessageId]).toBe('m-1');
      expect(headers['x-domain-toolCallId']).toBe('t-1');
    });

    it('tool-output-available carries preliminary and providerMetadata domain headers', async () => {
      const { encoder, channel } = makeEncoder();

      await encoder.encodePart(
        {
          type: 'tool-output-available',
          toolCallId: 't-1',
          output: 'partial',
          preliminary: true,
          providerMetadata: { anthropic: { cacheHit: true } },
        },
        { headers: { [Headers.MessageId]: 'm-1' } },
      );

      const [wire] = channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected one wire');
      const headers = headersOf(wire);
      expect(headers['x-domain-preliminary']).toBe('true');
      expect(headers['x-domain-providerMetadata']).toBe(JSON.stringify({ anthropic: { cacheHit: true } }));
    });

    it('tool-output-error publishes a discrete tool-output-error wire with errorText as data', async () => {
      const { encoder, channel } = makeEncoder();

      await encoder.encodePart(
        { type: 'tool-output-error', toolCallId: 't-1', errorText: 'rate limited' },
        { headers: { [Headers.MessageId]: 'm-1' } },
      );

      const [wire] = channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected one wire');
      expect(wire.name).toBe('tool-output-error');
      expect(wire.data).toBe('rate limited');
      const headers = headersOf(wire);
      expect(headers['x-domain-toolCallId']).toBe('t-1');
    });

    it('tool-input-error closes the stream with errorText so the decoder can discriminate', async () => {
      const { encoder, channel } = makeEncoder();
      await encoder.encodePart(
        { type: 'tool-input-start', toolCallId: 't-1', toolName: 'getWeather' },
        { headers: { [Headers.MessageId]: 'm-1' } },
      );

      await encoder.encodePart({
        type: 'tool-input-error',
        toolCallId: 't-1',
        toolName: 'getWeather',
        input: '{"city":',
        errorText: 'invalid JSON',
      });

      const closing = channel.appendedMessages.at(-1);
      if (!closing) throw new Error('expected a closing append');
      const headers = headersOf(closing);
      expect(headers[Headers.Status]).toBe('finished');
      expect(headers['x-domain-errorText']).toBe('invalid JSON');
      expect(headers['x-domain-input']).toBe(JSON.stringify('{"city":'));
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

    it('auto-aborts an open tool-input stream when the encoder closes mid-stream', async () => {
      const { encoder, channel } = makeEncoder();
      await encoder.encodePart(
        { type: 'tool-input-start', toolCallId: 't-1', toolName: 'getWeather' },
        { headers: { [Headers.MessageId]: 'm-1' } },
      );

      await encoder.close();

      const aborted = channel.appendedMessages.at(-1);
      if (!aborted) throw new Error('expected an aborted close-append');
      expect(headersOf(aborted)[Headers.Status]).toBe('aborted');
      // Persistent headers (toolName) are re-applied on the abort wire so
      // a history-only replay still sees the tool's identity.
      expect(headersOf(aborted)['x-domain-toolName']).toBe('getWeather');
    });
  });
});
