import type * as AI from 'ai';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Codec } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { createVercelCodec, vercel, type VercelEvent } from '../../../src/vercel/index.js';
import { deliveriesOf, encodeAll, historyOf, roundTrip } from '../../helper/wire.js';

/** The stream `toUIMessageStream` gives for a turn that calls a tool, then answers. */
const turn: VercelEvent[] = [
  { type: 'start', messageId: 'msg_1' },
  { type: 'start-step' },
  { type: 'tool-input-start', toolCallId: 'call_1', toolName: 'weather' },
  { type: 'tool-input-delta', toolCallId: 'call_1', inputTextDelta: '{"city":' },
  { type: 'tool-input-delta', toolCallId: 'call_1', inputTextDelta: '"London"}' },
  { type: 'tool-input-available', toolCallId: 'call_1', toolName: 'weather', input: { city: 'London' } },
  { type: 'tool-output-available', toolCallId: 'call_1', output: { temp: 21 } },
  { type: 'text-start', id: 'txt_1' },
  { type: 'text-delta', id: 'txt_1', delta: 'It is 21°C' },
  { type: 'text-delta', id: 'txt_1', delta: ' in London.' },
  { type: 'text-end', id: 'txt_1' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

describe('the Vercel codec', () => {
  let codec: Codec<VercelEvent>;

  beforeEach(() => {
    codec = createVercelCodec();
  });

  describe('encode', () => {
    it('turns a turn into one operation per chunk, streaming the tool input and the text', () => {
      const encoded = encodeAll(codec, turn);
      expect(
        encoded.map(({ message, ...ops }) => ({ name: message.name, data: message.data as unknown, ...ops })),
      ).toEqual([
        { name: 'ai', data: '' },
        { name: 'ai', data: '' },
        { name: 'ai', data: '' },
        { name: 'ai', data: '{"city":', append: 'call_1' },
        { name: 'ai', data: '"London"}', append: 'call_1' },
        { name: 'ai', data: '', ends: 'call_1' },
        { name: 'ai', data: { temp: 21 } },
        { name: 'ai', data: '' },
        { name: 'ai', data: 'It is 21°C', append: 'txt_1' },
        { name: 'ai', data: ' in London.', append: 'txt_1' },
        { name: 'ai', data: '', ends: 'txt_1' },
        { name: 'ai', data: '' },
        { name: 'ai', data: '' },
      ]);
    });

    it('puts no stream key on an opener or a closer, so only the deltas share a message', () => {
      const streamed: VercelEvent[] = [
        { type: 'text-start', id: 't' },
        { type: 'text-end', id: 't' },
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-end', id: 'r' },
        { type: 'tool-input-start', toolCallId: 'c', toolName: 'w' },
      ];
      for (const encoded of encodeAll(codec, streamed)) {
        expect(encoded.publish).toBeUndefined();
        expect(encoded.append).toBeUndefined();
      }
    });

    it('carries a chunk’s fields, its type included, under extras.headers and its type under extras.ai', () => {
      expect(codec.encode({ type: 'finish', finishReason: 'stop' })[0]?.message.extras).toEqual({
        ai: { type: 'finish' },
        headers: { type: 'finish', finishReason: 'stop' },
      });
      expect(codec.encode({ type: 'text-delta', id: 'txt_1', delta: 'hi' })[0]?.message.extras).toEqual({
        ai: { type: 'text-delta' },
        headers: { type: 'text-delta', id: 'txt_1' },
      });
      expect(codec.encode({ type: 'start-step' })[0]?.message.extras).toEqual({
        ai: { type: 'start-step' },
        headers: { type: 'start-step' },
      });
    });

    it('carries a nested field as JSON text in extras.headers, listed under extras.ai.json', () => {
      const [encoded] = codec.encode({
        type: 'tool-input-available',
        toolCallId: 'call_1',
        toolName: 'weather',
        input: { city: 'London' },
      });
      expect(encoded?.message.extras).toEqual({
        ai: { type: 'tool-input-available', json: ['input'] },
        headers: {
          type: 'tool-input-available',
          toolCallId: 'call_1',
          toolName: 'weather',
          input: '{"city":"London"}',
        },
      });
    });

    it('publishes tool-input-available with no live key, as the SDK emits it when tool input is not streamed', () => {
      const [encoded] = codec.encode({ type: 'tool-input-available', toolCallId: 'call_9', toolName: 't', input: {} });
      expect(encoded?.append).toBeUndefined();
      expect(encoded?.ends).toBe('call_9');
    });

    it('publishes a data part with its payload as the message data, ephemeral when transient', () => {
      expect(codec.encode({ type: 'data-weather', id: 'w1', data: { temp: 21 } })).toEqual([
        {
          message: {
            name: 'ai',
            data: { temp: 21 },
            extras: { ai: { type: 'data-weather' }, headers: { type: 'data-weather', id: 'w1' } },
          },
        },
      ]);
      expect(codec.encode({ type: 'data-progress', data: 0.5, transient: true })[0]?.message.extras).toEqual({
        ai: { type: 'data-progress' },
        headers: { type: 'data-progress', transient: true },
        ephemeral: true,
      });
    });

    it('publishes a user message as the message data', () => {
      const message: AI.UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
      expect(codec.encode({ type: 'user-message', message })).toEqual([
        { message: { name: 'ai', data: message, extras: { ai: { type: 'user-message' } } } },
      ]);
    });

    it('throws for a chunk type outside the union', () => {
      // CAST: an event outside the union, to exercise the unlisted-type path.
      const rogue = { type: 'not-a-chunk' } as unknown as VercelEvent;
      expect(() => codec.encode(rogue)).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('decode', () => {
    it('round-trips a turn chunk for chunk', () => {
      expect(roundTrip(codec, turn)).toStrictEqual(turn);
    });

    it('round-trips the chunks that travel whole', () => {
      const chunks: VercelEvent[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'tool-input-error', toolCallId: 'c1', toolName: 't', input: {}, errorText: 'bad' },
        { type: 'tool-output-error', toolCallId: 'c1', errorText: 'failed' },
        { type: 'tool-output-denied', toolCallId: 'c1' },
        { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
        { type: 'tool-approval-response', approvalId: 'a1', approved: true },
        { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
        { type: 'source-document', sourceId: 's2', mediaType: 'text/plain', title: 'doc' },
        { type: 'file', url: 'https://example.com/a.png', mediaType: 'image/png' },
        { type: 'reasoning-file', url: 'https://example.com/r.png', mediaType: 'image/png' },
        { type: 'custom', kind: 'acme.ping' },
        { type: 'reset-step' },
        { type: 'message-metadata', messageMetadata: { tokens: 3 } },
        { type: 'error', errorText: 'boom' },
        { type: 'abort', reason: 'user' },
        { type: 'data-weather', id: 'w1', data: { temp: 21 } },
      ];
      expect(roundTrip(codec, chunks)).toStrictEqual(chunks);
    });

    it('decodes history as the sequence the agent produced, with each stream’s deltas joined', () => {
      const decoded = historyOf(encodeAll(codec, turn)).flatMap((m) => codec.decode(m));
      expect(decoded).toStrictEqual([
        { type: 'start', messageId: 'msg_1' },
        { type: 'start-step' },
        { type: 'tool-input-start', toolCallId: 'call_1', toolName: 'weather' },
        { type: 'tool-input-delta', toolCallId: 'call_1', inputTextDelta: '{"city":"London"}' },
        { type: 'tool-input-available', toolCallId: 'call_1', toolName: 'weather', input: { city: 'London' } },
        { type: 'tool-output-available', toolCallId: 'call_1', output: { temp: 21 } },
        { type: 'text-start', id: 'txt_1' },
        { type: 'text-delta', id: 'txt_1', delta: 'It is 21°C in London.' },
        { type: 'text-end', id: 'txt_1' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);
    });

    it('decodes a chunk from the builder’s type when the spread type header is missing', () => {
      const [delivery] = deliveriesOf(encodeAll(codec, [{ type: 'finish', finishReason: 'stop' }]));
      if (delivery === undefined) throw new Error('fixture');
      // CAST: a fixture inbound message whose headers lost their type copy.
      const stripped = { ...delivery, extras: { ai: { type: 'finish' }, headers: { finishReason: 'stop' } } };
      expect(codec.decode(stripped as typeof delivery)).toEqual([{ type: 'finish', finishReason: 'stop' }]);
    });

    it('round-trips a user message', () => {
      const message: AI.UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
      expect(roundTrip(codec, [{ type: 'user-message', message }])).toStrictEqual([{ type: 'user-message', message }]);
    });

    it('decodes a late joiner’s full-content update to one delta carrying the text so far', () => {
      const [start, first, second] = deliveriesOf(encodeAll(codec, turn.slice(7, 10)));
      if (start === undefined || first === undefined || second === undefined) throw new Error('fixture');
      // A joiner who saw nothing of the stream receives the platform's
      // full-content update in place of the second append, on the message the
      // first delta opened.
      expect(second.serial).toBe(first.serial);
      const update = { ...second, action: 'message.update', data: 'It is 21°C in London.' };
      // CAST: a fixture inbound message.
      expect(codec.decode(update as typeof second)).toEqual([
        { type: 'text-delta', id: 'txt_1', delta: 'It is 21°C in London.' },
      ]);
    });

    it('throws for a user message whose data is not a UIMessage', () => {
      const [delivery] = deliveriesOf([
        { message: { name: 'ai', data: 'nope', extras: { ai: { type: 'user-message' } } } },
      ]);
      if (delivery === undefined) throw new Error('fixture');
      expect(() => codec.decode(delivery)).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('decodes nothing for a message that is not the codec’s', () => {
      const [delivery] = deliveriesOf([{ message: { name: 'chat', data: 'hello', extras: { headers: {} } } }]);
      if (delivery === undefined) throw new Error('fixture');
      expect(codec.decode(delivery)).toEqual([]);
    });
  });

  it('exports a prebuilt codec carrying the adapter tag', () => {
    expect(vercel.adapterTag).toBe('vercel-ai-sdk-ui-message');
    expect(Object.keys(vercel).toSorted()).toEqual(['adapterTag', 'decode', 'encode']);
  });
});
