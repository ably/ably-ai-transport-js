import type * as Ably from 'ably';
import type * as AI from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_HEADER_PREFIX as D,
  HEADER_MSG_ID,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
} from '../../../src/constants.js';
import type { ChannelWriter } from '../../../src/core/codec/types.js';
import { createEncoder } from '../../../src/vercel/codec/encoder.js';

// ---------------------------------------------------------------------------
// Mock writer
// ---------------------------------------------------------------------------

interface MockWriter extends ChannelWriter {
  publishCalls: (Ably.Message | Ably.Message[])[];
  appendCalls: Ably.Message[];
  updateCalls: Ably.Message[];
  nextPublishResult: Ably.PublishResult;
  nextAppendResult: Ably.UpdateDeleteResult;
}

const createMockWriter = (): MockWriter => {
  const mock: MockWriter = {
    publishCalls: [],
    appendCalls: [],
    updateCalls: [],
    nextPublishResult: { serials: ['serial-1'] } as Ably.PublishResult,
    nextAppendResult: {} as Ably.UpdateDeleteResult,
    publish: vi.fn(async (message: Ably.Message | Ably.Message[]) => {
      mock.publishCalls.push(message);
      return await Promise.resolve(mock.nextPublishResult);
    }),
    appendMessage: vi.fn(async (message: Ably.Message) => {
      mock.appendCalls.push(message);
      return await Promise.resolve(mock.nextAppendResult);
    }),
    updateMessage: vi.fn(async (message: Ably.Message) => {
      mock.updateCalls.push(message);
      return await Promise.resolve(mock.nextAppendResult);
    }),
  };
  return mock;
};

const headersOf = (msg: Ably.Message): Record<string, string> =>
  (msg.extras as { headers: Record<string, string> }).headers;

const firstPublish = (writer: MockWriter): Ably.Message => {
  const call = writer.publishCalls[0];
  if (!call) throw new Error('no publish calls');
  if (Array.isArray(call)) {
    const first = call[0];
    if (!first) throw new Error('empty batch');
    return first;
  }
  return call;
};

const lastPublish = (writer: MockWriter): Ably.Message => {
  const call = writer.publishCalls.at(-1);
  if (!call) throw new Error('no publish calls');
  if (Array.isArray(call)) {
    const first = call[0];
    if (!first) throw new Error('empty batch');
    return first;
  }
  return call;
};

const lastAppend = (writer: MockWriter): Ably.Message => {
  const msg = writer.appendCalls.at(-1);
  if (!msg) throw new Error('no append calls');
  return msg;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Vercel encoder', () => {
  let writer: MockWriter;

  beforeEach(() => {
    writer = createMockWriter();
  });

  // -- text streaming -------------------------------------------------------

  describe('text streaming', () => {
    it('encodes text-start as a streamed publish', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'text-start', id: 'txt-1' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('text');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('true');
      expect(headersOf(msg)[HEADER_STATUS]).toBe('streaming');
      expect(headersOf(msg)[HEADER_STREAM_ID]).toBe('txt-1');
      expect(headersOf(msg)[`${D}id`]).toBe('txt-1');
    });

    it('encodes text-delta as an append', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'text-start', id: 'txt-1' });
      await encoder.appendEvent({ type: 'text-delta', id: 'txt-1', delta: 'hello' });

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('hello');
    });

    it('encodes text-end as a closing append', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'text-start', id: 'txt-1' });
      await encoder.appendEvent({ type: 'text-end', id: 'txt-1' });

      const msg = lastAppend(writer);
      expect(headersOf(msg)[HEADER_STATUS]).toBe('finished');
    });

    it('includes providerMetadata on text-start and text-end', async () => {
      const pm = { anthropic: { key: 'value' } } as AI.ProviderMetadata;
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'text-start', id: 'txt-1', providerMetadata: pm });

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}providerMetadata`]).toBe(JSON.stringify(pm));
    });
  });

  // -- reasoning streaming --------------------------------------------------

  describe('reasoning streaming', () => {
    it('encodes reasoning-start/delta/end lifecycle', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'reasoning-start', id: 'r-1' });
      await encoder.appendEvent({ type: 'reasoning-delta', id: 'r-1', delta: 'think' });
      await encoder.appendEvent({ type: 'reasoning-end', id: 'r-1' });

      const startMsg = firstPublish(writer);
      expect(startMsg.name).toBe('reasoning');
      expect(headersOf(startMsg)[HEADER_STREAM_ID]).toBe('r-1');
      expect(writer.appendCalls).toHaveLength(2); // delta + close
    });
  });

  // -- tool-input streaming -------------------------------------------------

  describe('tool-input streaming', () => {
    it('encodes tool-input-start with tool metadata headers', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({
        type: 'tool-input-start',
        toolCallId: 'tc-1',
        toolName: 'search',
        title: 'Search',
        dynamic: true,
        providerExecuted: false,
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-input');
      expect(headersOf(msg)[HEADER_STREAM_ID]).toBe('tc-1');
      expect(headersOf(msg)[`${D}toolCallId`]).toBe('tc-1');
      expect(headersOf(msg)[`${D}toolName`]).toBe('search');
      expect(headersOf(msg)[`${D}title`]).toBe('Search');
      expect(headersOf(msg)[`${D}dynamic`]).toBe('true');
      expect(headersOf(msg)[`${D}providerExecuted`]).toBe('false');
    });

    it('encodes tool-input-delta as append', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' });
      await encoder.appendEvent({ type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '{"q":' });

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('{"q":');
    });

    it('encodes tool-input-available as close for streamed tool', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' });
      await encoder.appendEvent({
        type: 'tool-input-available',
        toolCallId: 'tc-1',
        toolName: 'search',
        input: { q: 'test' },
      });

      const msg = lastAppend(writer);
      expect(headersOf(msg)[HEADER_STATUS]).toBe('finished');
    });

    it('encodes non-streaming tool-input-available as discrete', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({
        type: 'tool-input-available',
        toolCallId: 'tc-2',
        toolName: 'calc',
        input: { x: 42 },
      });

      // Should be a discrete publish, not a stream close
      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-input');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      expect(msg.data).toEqual({ x: 42 });
    });
  });

  // -- lifecycle events -----------------------------------------------------

  describe('lifecycle events', () => {
    it('encodes start with messageId and messageMetadata', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'start', messageId: 'msg-1', messageMetadata: { key: 'val' } });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('start');
      expect(headersOf(msg)[`${D}messageId`]).toBe('msg-1');
      expect(headersOf(msg)[`${D}messageMetadata`]).toBe(JSON.stringify({ key: 'val' }));
    });

    it('publishes messageId domain header from start chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'start', messageId: 'msg-1' });

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}messageId`]).toBe('msg-1');
    });

    it('omits messageId domain header when start chunk has no messageId', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'start' });

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}messageId`]).toBeUndefined();
    });

    it('stamps x-ably-msg-id from WriteOptions on all publishes', async () => {
      const encoder = createEncoder(writer);
      const perWrite = { messageId: 'msg-1' };
      await encoder.appendEvent({ type: 'start', messageId: 'msg-1' }, perWrite);
      await encoder.appendEvent({ type: 'text-start', id: 'txt-1' }, perWrite);

      const startMsg = firstPublish(writer);
      expect(headersOf(startMsg)[HEADER_MSG_ID]).toBe('msg-1');

      const textMsg = writer.publishCalls[1] as Ably.Message;
      expect(headersOf(textMsg)[HEADER_MSG_ID]).toBe('msg-1');
    });

    it('encodes finish-step', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'finish-step' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('finish-step');
    });

    it('encodes finish with finishReason', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'finish', finishReason: 'stop' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('finish');
      expect(headersOf(msg)[`${D}finishReason`]).toBe('stop');
    });

    it('encodes error with errorText', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'error', errorText: 'something failed' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('error');
      expect(msg.data).toBe('something failed');
    });

    it('encodes abort and aborts all streams', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'text-start', id: 'txt-1' });
      await encoder.appendEvent({ type: 'abort', reason: 'cancelled' });

      // Should have: publish (text-start), append (abort stream), publish (abort event)
      const abortMsg = lastPublish(writer);
      expect(abortMsg.name).toBe('abort');
      expect(abortMsg.data).toBe('cancelled');
      expect(headersOf(abortMsg)[HEADER_STATUS]).toBe('aborted');

      // The stream should have been aborted
      const abortAppend = writer.appendCalls.find(
        (m) => headersOf(m)[HEADER_STATUS] === 'aborted',
      );
      expect(abortAppend).toBeDefined();
    });

    it('abort() aborts all streams and publishes abort event', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'text-start', id: 'txt-1' });
      await encoder.abort('cancelled');

      const abortMsg = lastPublish(writer);
      expect(abortMsg.name).toBe('abort');
      expect(abortMsg.data).toBe('cancelled');
      expect(headersOf(abortMsg)[HEADER_STATUS]).toBe('aborted');

      const abortAppend = writer.appendCalls.find(
        (m) => headersOf(m)[HEADER_STATUS] === 'aborted',
      );
      expect(abortAppend).toBeDefined();
    });

    it('abort() is idempotent — second call is a no-op', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'text-start', id: 'txt-1' });

      await encoder.abort('cancelled');
      const publishCountAfterFirst = writer.publishCalls.length;
      const appendCountAfterFirst = writer.appendCalls.length;

      await encoder.abort('cancelled');
      expect(writer.publishCalls.length).toBe(publishCountAfterFirst);
      expect(writer.appendCalls.length).toBe(appendCountAfterFirst);
    });

    it('abort() with no open streams publishes only the abort discrete event with status header', async () => {
      const encoder = createEncoder(writer);
      await encoder.abort('user-stop');

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe('abort');
      expect(msg.data).toBe('user-stop');
      expect(headersOf(msg)[HEADER_STATUS]).toBe('aborted');
      expect(writer.appendCalls).toHaveLength(0);
    });

    it('encodes start-step as a discrete message', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'start-step' });

      expect(writer.publishCalls).toHaveLength(1);
      expect(firstPublish(writer)).toEqual(
        expect.objectContaining({ name: 'start-step' }),
      );
    });
  });

  // -- tool lifecycle events ------------------------------------------------

  describe('tool lifecycle events', () => {
    it('encodes tool-input-error', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({
        type: 'tool-input-error',
        toolCallId: 'tc-1',
        toolName: 'search',
        errorText: 'parse error',
        input: { bad: true },
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-input-error');
      expect(msg.data).toEqual({ errorText: 'parse error', input: { bad: true } });
      expect(headersOf(msg)[`${D}toolCallId`]).toBe('tc-1');
    });

    it('encodes tool-output-available', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { result: 42 },
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-output-available');
      expect(msg.data).toEqual({ output: { result: 42 } });
    });

    it('encodes tool-output-error', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({
        type: 'tool-output-error',
        toolCallId: 'tc-1',
        errorText: 'timeout',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-output-error');
      expect(msg.data).toEqual({ errorText: 'timeout' });
    });

    it('encodes tool-approval-request', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({
        type: 'tool-approval-request',
        toolCallId: 'tc-1',
        approvalId: 'apr-1',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-approval-request');
      expect(headersOf(msg)[`${D}toolCallId`]).toBe('tc-1');
      expect(headersOf(msg)[`${D}approvalId`]).toBe('apr-1');
    });

    it('encodes tool-output-denied', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({
        type: 'tool-output-denied',
        toolCallId: 'tc-1',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-output-denied');
    });
  });

  // -- content parts --------------------------------------------------------

  describe('content parts', () => {
    it('encodes file chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('file');
      expect(msg.data).toBe('https://example.com/img.png');
      expect(headersOf(msg)[`${D}mediaType`]).toBe('image/png');
    });

    it('encodes source-url chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({
        type: 'source-url',
        sourceId: 'src-1',
        url: 'https://example.com',
        title: 'Example',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('source-url');
      expect(headersOf(msg)[`${D}sourceId`]).toBe('src-1');
      expect(headersOf(msg)[`${D}title`]).toBe('Example');
    });

    it('encodes source-document chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({
        type: 'source-document',
        sourceId: 'src-1',
        mediaType: 'application/pdf',
        title: 'Doc',
        filename: 'doc.pdf',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('source-document');
      expect(headersOf(msg)[`${D}filename`]).toBe('doc.pdf');
    });

    it('encodes message-metadata chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent({ type: 'message-metadata', messageMetadata: { key: 'val' } });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('message-metadata');
      expect(headersOf(msg)[`${D}messageMetadata`]).toBe(JSON.stringify({ key: 'val' }));
    });
  });

  // -- data-* chunks --------------------------------------------------------

  describe('data-* chunks', () => {
    it('encodes data-* chunk as discrete', async () => {
      const encoder = createEncoder(writer);
      const chunk = { type: 'data-custom' as const, data: { foo: 'bar' }, id: 'dc-1' };
      await encoder.appendEvent(chunk);

      const msg = firstPublish(writer);
      expect(msg.name).toBe('data-custom');
      expect(msg.data).toEqual({ foo: 'bar' });
      expect(headersOf(msg)[`${D}id`]).toBe('dc-1');
    });

    it('marks transient data-* chunks as ephemeral', async () => {
      const encoder = createEncoder(writer);
      const chunk = { type: 'data-status' as const, data: undefined, transient: true };
      await encoder.appendEvent(chunk);

      const msg = firstPublish(writer);
      expect((msg.extras as { ephemeral?: boolean }).ephemeral).toBe(true);
    });
  });

  // -- writeEvent -----------------------------------------------------------

  describe('writeEvent', () => {
    it('publishes data-* chunk as discrete event', async () => {
      const encoder = createEncoder(writer);
      const chunk = { type: 'data-ping' as const, data: 'pong', id: 'p-1' };
      const result = await encoder.writeEvent(chunk);

      expect(result).toEqual({ serials: ['serial-1'] });
      const msg = firstPublish(writer);
      expect(msg.name).toBe('data-ping');
    });

    it('throws for non-data-* chunk types', async () => {
      const encoder = createEncoder(writer);
      await expect(
        encoder.writeEvent({ type: 'start' } as AI.UIMessageChunk),
      ).rejects.toThrow('unable to write event');
    });
  });

  // -- writeMessages --------------------------------------------------------

  describe('writeMessages', () => {
    it('publishes UIMessage parts as discrete batch', async () => {
      const encoder = createEncoder(writer);
      const msg: AI.UIMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' },
        ],
      };

      await encoder.writeMessages([msg]);

      // Should be a single batch publish with 2 messages
      expect(writer.publishCalls).toHaveLength(1);
      const batch = writer.publishCalls[0] as Ably.Message[];
      expect(batch).toHaveLength(2);

      const first = batch[0];
      expect(first?.name).toBe('text');
      expect(first?.data).toBe('hello');
      if (first) expect(headersOf(first)[`${D}messageId`]).toBe('msg-1');

      expect(batch[1]?.name).toBe('file');
      expect(batch[1]?.data).toBe('https://example.com/img.png');
    });

    it('publishes empty text part for message with no parts', async () => {
      const encoder = createEncoder(writer);
      const msg: AI.UIMessage = { id: 'msg-1', role: 'user', parts: [] };

      await encoder.writeMessages([msg]);

      const batch = writer.publishCalls[0] as Ably.Message[];
      expect(batch).toHaveLength(1);
      expect(batch[0]?.name).toBe('text');
      expect(batch[0]?.data).toBe('');
    });

    it('publishes multiple messages as a single batch', async () => {
      const encoder = createEncoder(writer);
      const msgs: AI.UIMessage[] = [
        { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'msg-2', role: 'user', parts: [{ type: 'text', text: 'bye' }] },
      ];

      await encoder.writeMessages(msgs);

      expect(writer.publishCalls).toHaveLength(1);
      const batch = writer.publishCalls[0] as Ably.Message[];
      expect(batch).toHaveLength(2);
    });
  });

  // -- close ----------------------------------------------------------------

  describe('close', () => {
    it('flushes and closes the encoder', async () => {
      const encoder = createEncoder(writer);
      await encoder.close();

      // Should not throw on double close
      await encoder.close();
    });
  });
});
