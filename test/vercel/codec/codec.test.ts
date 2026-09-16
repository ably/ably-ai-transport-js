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
      // A plain publish carries the whole chunk as the body; a delta carries
      // its text, appended under the stream key.
      expect(
        encoded.map(({ message, ...ops }) => ({ name: message.name, data: message.data as unknown, ...ops })),
      ).toEqual([
        { name: 'ai', data: turn[0] },
        { name: 'ai', data: turn[1] },
        { name: 'ai', data: turn[2] },
        { name: 'ai', data: '{"city":', append: 'call_1' },
        { name: 'ai', data: '"London"}', append: 'call_1' },
        { name: 'ai', data: turn[5], ends: 'call_1' },
        { name: 'ai', data: turn[6] },
        { name: 'ai', data: turn[7] },
        { name: 'ai', data: 'It is 21°C', append: 'txt_1' },
        { name: 'ai', data: ' in London.', append: 'txt_1' },
        { name: 'ai', data: turn[10], ends: 'txt_1' },
        { name: 'ai', data: turn[11] },
        { name: 'ai', data: turn[12] },
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

    it('carries a plain publish whole as the message body, with only its type under extras.ai', () => {
      expect(codec.encode({ type: 'finish', finishReason: 'stop' })[0]?.message).toEqual({
        name: 'ai',
        data: { type: 'finish', finishReason: 'stop' },
        extras: { ai: { type: 'finish' } },
      });
      expect(codec.encode({ type: 'start-step' })[0]?.message).toEqual({
        name: 'ai',
        data: { type: 'start-step' },
        extras: { ai: { type: 'start-step' } },
      });
    });

    it('carries a delta’s text as the body and the rest of the chunk under extras.headers', () => {
      expect(codec.encode({ type: 'text-delta', id: 'txt_1', delta: 'hi' })[0]?.message).toEqual({
        name: 'ai',
        data: 'hi',
        extras: { ai: { type: 'text-delta' }, headers: { type: 'text-delta', id: 'txt_1' } },
      });
    });

    it('carries a delta’s nested field as JSON text in extras.headers, listed under extras.ai.json', () => {
      const [encoded] = codec.encode({
        type: 'text-delta',
        id: 'txt_1',
        delta: 'hi',
        providerMetadata: { openai: { itemId: 'msg_1' } },
      });
      expect(encoded?.message.extras).toEqual({
        ai: { type: 'text-delta', json: ['providerMetadata'] },
        headers: { type: 'text-delta', id: 'txt_1', providerMetadata: '{"openai":{"itemId":"msg_1"}}' },
      });
    });

    it('carries a plain publish’s nested field as an object in the body, with no extras.ai.json', () => {
      const chunk: VercelEvent = {
        type: 'tool-input-available',
        toolCallId: 'call_1',
        toolName: 'weather',
        input: { city: 'London' },
      };
      const [encoded] = codec.encode(chunk);
      expect(encoded?.message).toEqual({
        name: 'ai',
        data: chunk,
        extras: { ai: { type: 'tool-input-available' } },
      });
    });

    it('publishes tool-input-available with no live key, as the SDK emits it when tool input is not streamed', () => {
      const [encoded] = codec.encode({ type: 'tool-input-available', toolCallId: 'call_9', toolName: 't', input: {} });
      expect(encoded?.append).toBeUndefined();
      expect(encoded?.ends).toBe('call_9');
    });

    it('publishes a data part whole as the message data, ephemeral when transient', () => {
      expect(codec.encode({ type: 'data-weather', id: 'w1', data: { temp: 21 } })).toEqual([
        {
          message: {
            name: 'ai',
            data: { type: 'data-weather', id: 'w1', data: { temp: 21 } },
            extras: { ai: { type: 'data-weather' } },
          },
        },
      ]);
      expect(codec.encode({ type: 'data-progress', data: 0.5, transient: true })[0]?.message.extras).toEqual({
        ai: { type: 'data-progress' },
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

    it('throws for a plain publish whose body is not an object', () => {
      const [delivery] = deliveriesOf([{ message: { name: 'ai', data: 'nope', extras: { ai: { type: 'finish' } } } }]);
      if (delivery === undefined) throw new Error('fixture');
      expect(() => codec.decode(delivery)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to decode finish; data is not an object',
      });
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
