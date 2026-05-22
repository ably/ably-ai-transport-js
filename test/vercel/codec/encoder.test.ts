import type * as Ably from 'ably';
import type * as AI from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_HEADER_PREFIX as D,
  HEADER_DISCRETE,
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
    // CAST: Tests construct a minimal Ably.PublishResult; full shape isn't needed.
    nextPublishResult: { serials: ['serial-1'] } as Ably.PublishResult,
    // CAST: Tests construct a minimal Ably.UpdateDeleteResult; full shape isn't needed.
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

const headersOf = (msg: Ably.Message): Record<string, string> => {
  // CAST: Tests build messages with extras shaped { headers: ... }.
  const extras = msg.extras as { headers: Record<string, string> };
  return extras.headers;
};

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
      await encoder.publish({ type: 'text-start', id: 'txt-1' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('text');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('true');
      expect(headersOf(msg)[HEADER_STATUS]).toBe('streaming');
      expect(headersOf(msg)[HEADER_STREAM_ID]).toBe('txt-1');
      expect(headersOf(msg)[`${D}id`]).toBe('txt-1');
    });

    it('encodes text-delta as an append', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'text-start', id: 'txt-1' });
      await encoder.publish({ type: 'text-delta', id: 'txt-1', delta: 'hello' });

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('hello');
    });

    it('encodes text-end as a closing append', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'text-start', id: 'txt-1' });
      await encoder.publish({ type: 'text-end', id: 'txt-1' });

      const msg = lastAppend(writer);
      expect(headersOf(msg)[HEADER_STATUS]).toBe('finished');
    });

    it('includes providerMetadata on text-start and text-end', async () => {
      // CAST: Trust boundary — providerMetadata is opaque to the encoder.
      const pm = { anthropic: { key: 'value' } } as AI.ProviderMetadata;
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'text-start', id: 'txt-1', providerMetadata: pm });

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}providerMetadata`]).toBe(JSON.stringify(pm));
    });
  });

  // -- reasoning streaming --------------------------------------------------

  describe('reasoning streaming', () => {
    it('encodes reasoning-start/delta/end lifecycle', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'reasoning-start', id: 'r-1' });
      await encoder.publish({ type: 'reasoning-delta', id: 'r-1', delta: 'think' });
      await encoder.publish({ type: 'reasoning-end', id: 'r-1' });

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
      await encoder.publish({
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
      await encoder.publish({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' });
      await encoder.publish({ type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '{"q":' });

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('{"q":');
    });

    it('encodes tool-input-available as close for streamed tool', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' });
      await encoder.publish({
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
      await encoder.publish({
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
      await encoder.publish({ type: 'start', messageId: 'msg-1', messageMetadata: { key: 'val' } });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('start');
      expect(headersOf(msg)[`${D}messageId`]).toBe('msg-1');
      expect(headersOf(msg)[`${D}messageMetadata`]).toBe(JSON.stringify({ key: 'val' }));
    });

    it('publishes messageId domain header from start chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'start', messageId: 'msg-1' });

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}messageId`]).toBe('msg-1');
    });

    it('omits messageId domain header when neither chunk nor options provide it', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'start' });

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}messageId`]).toBeUndefined();
    });

    it('falls back to options.messageId when start chunk has no messageId', async () => {
      const encoder = createEncoder(writer, { messageId: 'fallback-id' });
      await encoder.publish({ type: 'start' });

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}messageId`]).toBe('fallback-id');
    });

    it('prefers chunk.messageId over options.messageId', async () => {
      const encoder = createEncoder(writer, { messageId: 'fallback-id' });
      await encoder.publish({ type: 'start', messageId: 'chunk-id' });

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}messageId`]).toBe('chunk-id');
    });

    it('stamps x-ably-msg-id from WriteOptions on all publishes', async () => {
      const encoder = createEncoder(writer);
      const perWrite = { messageId: 'msg-1' };
      await encoder.publish({ type: 'start', messageId: 'msg-1' }, perWrite);
      await encoder.publish({ type: 'text-start', id: 'txt-1' }, perWrite);

      const startMsg = firstPublish(writer);
      expect(headersOf(startMsg)[HEADER_MSG_ID]).toBe('msg-1');

      const second = writer.publishCalls[1];
      if (!second || Array.isArray(second)) throw new Error('expected single-message second publish');
      expect(headersOf(second)[HEADER_MSG_ID]).toBe('msg-1');
    });

    it('encodes finish-step', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'finish-step' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('finish-step');
    });

    it('encodes finish with finishReason', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'finish', finishReason: 'stop' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('finish');
      expect(headersOf(msg)[`${D}finishReason`]).toBe('stop');
    });

    it('encodes error with errorText', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'error', errorText: 'something failed' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('error');
      expect(msg.data).toBe('something failed');
    });

    it('encodes abort and aborts all streams', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'text-start', id: 'txt-1' });
      await encoder.publish({ type: 'abort', reason: 'cancelled' });

      // Should have: publish (text-start), append (abort stream), publish (abort event)
      const abortMsg = lastPublish(writer);
      expect(abortMsg.name).toBe('abort');
      expect(abortMsg.data).toBe('cancelled');
      expect(headersOf(abortMsg)[HEADER_STATUS]).toBe('aborted');

      // The stream should have been aborted
      const abortAppend = writer.appendCalls.find((m) => headersOf(m)[HEADER_STATUS] === 'aborted');
      expect(abortAppend).toBeDefined();
    });

    it('abort() aborts all streams and publishes abort event', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'text-start', id: 'txt-1' });
      await encoder.abort('cancelled');

      const abortMsg = lastPublish(writer);
      expect(abortMsg.name).toBe('abort');
      expect(abortMsg.data).toBe('cancelled');
      expect(headersOf(abortMsg)[HEADER_STATUS]).toBe('aborted');

      const abortAppend = writer.appendCalls.find((m) => headersOf(m)[HEADER_STATUS] === 'aborted');
      expect(abortAppend).toBeDefined();
    });

    it('abort() is idempotent — second call is a no-op', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({ type: 'text-start', id: 'txt-1' });

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
      await encoder.publish({ type: 'start-step' });

      expect(writer.publishCalls).toHaveLength(1);
      expect(firstPublish(writer)).toEqual(expect.objectContaining({ name: 'start-step' }));
    });
  });

  // -- tool lifecycle events ------------------------------------------------

  describe('tool lifecycle events', () => {
    it('encodes tool-input-error', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({
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
      await encoder.publish({
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
      await encoder.publish({
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
      await encoder.publish({
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
      await encoder.publish({
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
      await encoder.publish({ type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe('file');
      expect(msg.data).toBe('https://example.com/img.png');
      expect(headersOf(msg)[`${D}mediaType`]).toBe('image/png');
    });

    it('encodes source-url chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish({
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
      await encoder.publish({
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
      await encoder.publish({ type: 'message-metadata', messageMetadata: { key: 'val' } });

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
      await encoder.publish(chunk);

      const msg = firstPublish(writer);
      expect(msg.name).toBe('data-custom');
      expect(msg.data).toEqual({ foo: 'bar' });
      expect(headersOf(msg)[`${D}id`]).toBe('dc-1');
    });

    it('marks transient data-* chunks as ephemeral', async () => {
      const encoder = createEncoder(writer);
      const chunk = { type: 'data-status' as const, data: undefined, transient: true };
      await encoder.publish(chunk);

      const msg = firstPublish(writer);
      // CAST: Tests inspect the ephemeral field set by the encoder.
      const extras = msg.extras as { ephemeral?: boolean };
      expect(extras.ephemeral).toBe(true);
    });
  });

  // -- user message events (codec-local TEvent) -----------------------------

  describe('publishing user-message events', () => {
    it('publishes UIMessage parts as discrete batch tagged x-ably-discrete', async () => {
      const encoder = createEncoder(writer);
      const msg: AI.UIMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' },
        ],
      };

      await encoder.publish({ type: 'ait-user-message', message: msg });

      // Should be a single batch publish with 2 messages
      expect(writer.publishCalls).toHaveLength(1);
      const call = writer.publishCalls[0];
      if (!Array.isArray(call)) throw new Error('expected batch publish');
      expect(call).toHaveLength(2);

      const first = call[0];
      expect(first?.name).toBe('text');
      expect(first?.data).toBe('hello');
      if (first) {
        expect(headersOf(first)[`${D}messageId`]).toBe('msg-1');
        expect(headersOf(first)[HEADER_DISCRETE]).toBe('true');
      }

      expect(call[1]?.name).toBe('file');
      expect(call[1]?.data).toBe('https://example.com/img.png');
    });

    it('publishes an empty text part for a message with no parts', async () => {
      const encoder = createEncoder(writer);
      const msg: AI.UIMessage = { id: 'msg-1', role: 'user', parts: [] };

      await encoder.publish({ type: 'ait-user-message', message: msg });

      const call = writer.publishCalls[0];
      if (!Array.isArray(call)) throw new Error('expected batch publish');
      expect(call).toHaveLength(1);
      expect(call[0]?.name).toBe('text');
      expect(call[0]?.data).toBe('');
    });
  });

  // -- tool-approval-response events (codec-local TEvent) ------------------

  describe('publishing tool-approval-response events', () => {
    it('publishes a discrete tool-approval-response with toolCallId/approved/reason headers and no amend header', async () => {
      const encoder = createEncoder(writer);
      // The encoder's per-write `messageId` carries the continuation's own
      // wire id — it is NOT used to target the original assistant.
      await encoder.publish(
        {
          type: 'tool-approval-response',
          toolCallId: 'tc-1',
          approved: true,
          reason: 'looks good',
        },
        { messageId: 'continuation-msg-id' },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-approval-response');
      expect(headersOf(msg)[`${D}toolCallId`]).toBe('tc-1');
      expect(headersOf(msg)[`${D}approved`]).toBe('true');
      expect(headersOf(msg)[`${D}reason`]).toBe('looks good');
      // HEADER_MSG_ID comes from perWrite.messageId — the continuation's
      // own new wire id. The reducer routes to the original assistant by
      // toolCallId, not by msg-id.
      expect(headersOf(msg)[HEADER_MSG_ID]).toBe('continuation-msg-id');
      // No HEADER_AMEND on the wire — the amend concept has been retired.
      expect(headersOf(msg)['x-ably-amend']).toBeUndefined();
    });
  });

  // -- ait-regenerate events (codec-local TEvent) -------------------------

  describe('publishing ait-regenerate events', () => {
    it('publishes a discrete ait-regenerate wire with empty data; routing metadata travels on transport headers', async () => {
      const encoder = createEncoder(writer);
      // The client-session builds transport headers (msg-id, prompt-id,
      // run-id, parent, msg-regenerate, role) and passes them as
      // `extras.headers` on the per-write options. The encoder forwards
      // them onto the wire and carries no domain payload of its own.
      await encoder.publish(
        {
          type: 'ait-regenerate',
          regeneratesMsgId: 'asst-A1',
          parentMsgId: 'user-U1',
        },
        {
          messageId: 'regen-msg-id',
          extras: {
            headers: {
              [HEADER_MSG_ID]: 'regen-msg-id',
              'x-ably-prompt-id': 'prompt-1',
              'x-ably-role': 'user',
              'x-ably-parent': 'user-U1',
              'x-ably-msg-regenerate': 'asst-A1',
            },
          },
        },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe('ait-regenerate');
      expect(msg.data).toBe('');
      const headers = headersOf(msg);
      expect(headers[HEADER_MSG_ID]).toBe('regen-msg-id');
      expect(headers['x-ably-prompt-id']).toBe('prompt-1');
      expect(headers['x-ably-role']).toBe('user');
      expect(headers['x-ably-parent']).toBe('user-U1');
      expect(headers['x-ably-msg-regenerate']).toBe('asst-A1');
    });
  });

  // -- client tool output chunks (UIMessageChunk path) ----------------------

  describe('publishing client tool output chunks', () => {
    it('publishes a tool-output-available UIMessageChunk via the standard discrete path', async () => {
      const encoder = createEncoder(writer);
      // Client-published continuation tool outputs ride as standard
      // `tool-output-available` chunks — the wire's HEADER_MSG_ID is the
      // continuation's own id (from perWrite.messageId), not the target
      // assistant's. The reducer redirects by toolCallId.
      await encoder.publish(
        {
          type: 'tool-output-available',
          toolCallId: 'tc-1',
          output: { latitude: 51.5, longitude: -0.1 },
        },
        { messageId: 'continuation-msg-id' },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-output-available');
      expect(headersOf(msg)[`${D}toolCallId`]).toBe('tc-1');
      expect(headersOf(msg)[HEADER_MSG_ID]).toBe('continuation-msg-id');
      expect(headersOf(msg)['x-ably-amend']).toBeUndefined();
      // CAST: data is unknown — we know the encoder shape from above.
      const data = msg.data as { output: unknown };
      expect(data.output).toEqual({ latitude: 51.5, longitude: -0.1 });
    });

    it('publishes a tool-output-error UIMessageChunk via the standard discrete path', async () => {
      const encoder = createEncoder(writer);
      await encoder.publish(
        {
          type: 'tool-output-error',
          toolCallId: 'tc-1',
          errorText: 'geolocation denied',
        },
        { messageId: 'continuation-msg-id' },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-output-error');
      expect(headersOf(msg)[`${D}toolCallId`]).toBe('tc-1');
      expect(headersOf(msg)[HEADER_MSG_ID]).toBe('continuation-msg-id');
      expect(headersOf(msg)['x-ably-amend']).toBeUndefined();
      // CAST: data is unknown — we know the encoder shape from above.
      const data = msg.data as { errorText: string };
      expect(data.errorText).toBe('geolocation denied');
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
