import type * as Ably from 'ably';
import type * as AI from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_AI_INPUT,
  EVENT_AI_OUTPUT,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_DISCRETE,
  HEADER_ROLE,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
} from '../../../src/constants.js';
import type { ChannelWriter } from '../../../src/core/codec/types.js';
import { createUIMessageCodec, type ForkSeed } from '../../../src/vercel/codec/index.js';

const UIMessageCodec = createUIMessageCodec();

// The codec is now assembled by defineCodec; createEncoder is the generic
// factory it produces (a plain closure, safe to destructure).
const createEncoder = UIMessageCodec.createEncoder;
const createDecoder = UIMessageCodec.createDecoder;

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
    nextPublishResult: { serials: ['serial-1'] },
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
  // CAST: the encoder writes headers under the disjoint transport/codec tiers
  // of extras.ai; merging them gives a flat view keyed by bare header names.
  const extras = msg.extras as { ai?: { transport?: Record<string, string>; codec?: Record<string, string> } };
  return { ...extras.ai?.transport, ...extras.ai?.codec };
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
      await encoder.publishOutput({ type: 'text-start', id: 'txt-1' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('text');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('true');
      expect(headersOf(msg)[HEADER_STATUS]).toBe('streaming');
      expect(headersOf(msg)[HEADER_STREAM_ID]).toBe('txt-1');
      expect(headersOf(msg).id).toBe('txt-1');
    });

    it('encodes text-delta as an append', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'text-start', id: 'txt-1' });
      await encoder.publishOutput({ type: 'text-delta', id: 'txt-1', delta: 'hello' });

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('hello');
    });

    it('encodes text-end as a closing append', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'text-start', id: 'txt-1' });
      await encoder.publishOutput({ type: 'text-end', id: 'txt-1' });

      const msg = lastAppend(writer);
      expect(headersOf(msg)[HEADER_STATUS]).toBe('complete');
    });

    it('includes providerMetadata on text-start and text-end', async () => {
      // CAST: Trust boundary — providerMetadata is opaque to the encoder.
      const pm = { anthropic: { key: 'value' } } as AI.ProviderMetadata;
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'text-start', id: 'txt-1', providerMetadata: pm });

      const msg = firstPublish(writer);
      expect(headersOf(msg).providerMetadata).toBe(JSON.stringify(pm));
    });
  });

  // -- reasoning streaming --------------------------------------------------

  describe('reasoning streaming', () => {
    it('encodes reasoning-start/delta/end lifecycle', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'reasoning-start', id: 'r-1' });
      await encoder.publishOutput({ type: 'reasoning-delta', id: 'r-1', delta: 'think' });
      await encoder.publishOutput({ type: 'reasoning-end', id: 'r-1' });

      const startMsg = firstPublish(writer);
      expect(startMsg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(startMsg).kind).toBe('reasoning');
      expect(headersOf(startMsg)[HEADER_STREAM_ID]).toBe('r-1');
      expect(writer.appendCalls).toHaveLength(2); // delta + close
    });
  });

  // -- tool-input streaming -------------------------------------------------

  describe('tool-input streaming', () => {
    it('encodes tool-input-start with tool metadata headers', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({
        type: 'tool-input-start',
        toolCallId: 'tc-1',
        toolName: 'search',
        title: 'Search',
        dynamic: true,
        providerExecuted: false,
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('tool-input');
      expect(headersOf(msg)[HEADER_STREAM_ID]).toBe('tc-1');
      expect(headersOf(msg).toolCallId).toBe('tc-1');
      expect(headersOf(msg).toolName).toBe('search');
      expect(headersOf(msg).title).toBe('Search');
      expect(headersOf(msg).dynamic).toBe('true');
      expect(headersOf(msg).providerExecuted).toBe('false');
    });

    it('encodes tool-input-delta as append', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' });
      await encoder.publishOutput({ type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '{"q":' });

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('{"q":');
    });

    it('encodes tool-input-available as close for streamed tool', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' });
      await encoder.publishOutput({
        type: 'tool-input-available',
        toolCallId: 'tc-1',
        toolName: 'search',
        input: { q: 'test' },
      });

      const msg = lastAppend(writer);
      expect(headersOf(msg)[HEADER_STATUS]).toBe('complete');
    });

    it('encodes non-streaming tool-input-available as discrete', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({
        type: 'tool-input-available',
        toolCallId: 'tc-2',
        toolName: 'calc',
        input: { x: 42 },
      });

      // Should be a discrete publish, not a stream close
      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('tool-input');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      expect(msg.data).toEqual({ x: 42 });
    });
  });

  // -- lifecycle events -----------------------------------------------------

  describe('lifecycle events', () => {
    it('encodes start with messageId and messageMetadata', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'start', messageId: 'msg-1', messageMetadata: { key: 'val' } });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('start');
      expect(headersOf(msg).messageId).toBe('msg-1');
      expect(headersOf(msg).messageMetadata).toBe(JSON.stringify({ key: 'val' }));
    });

    it('publishes messageId domain header from start chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'start', messageId: 'msg-1' });

      const msg = firstPublish(writer);
      expect(headersOf(msg).messageId).toBe('msg-1');
    });

    it('omits messageId domain header when neither chunk nor options provide it', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'start' });

      const msg = firstPublish(writer);
      expect(headersOf(msg).messageId).toBeUndefined();
    });

    it('falls back to options.messageId when start chunk has no messageId', async () => {
      const encoder = createEncoder(writer, { messageId: 'fallback-id' });
      await encoder.publishOutput({ type: 'start' });

      const msg = firstPublish(writer);
      expect(headersOf(msg).messageId).toBe('fallback-id');
    });

    it('prefers chunk.messageId over options.messageId', async () => {
      const encoder = createEncoder(writer, { messageId: 'fallback-id' });
      await encoder.publishOutput({ type: 'start', messageId: 'chunk-id' });

      const msg = firstPublish(writer);
      expect(headersOf(msg).messageId).toBe('chunk-id');
    });

    it('stamps codec-message-id from WriteOptions on all publishes', async () => {
      const encoder = createEncoder(writer);
      const perWrite = { messageId: 'msg-1' };
      await encoder.publishOutput({ type: 'start', messageId: 'msg-1' }, perWrite);
      await encoder.publishOutput({ type: 'text-start', id: 'txt-1' }, perWrite);

      const startMsg = firstPublish(writer);
      expect(headersOf(startMsg)[HEADER_CODEC_MESSAGE_ID]).toBe('msg-1');

      const second = writer.publishCalls[1];
      if (!second || Array.isArray(second)) throw new Error('expected single-message second publish');
      expect(headersOf(second)[HEADER_CODEC_MESSAGE_ID]).toBe('msg-1');
    });

    it('encodes finish-step', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'finish-step' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('finish-step');
    });

    it('encodes finish with finishReason', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'finish', finishReason: 'stop' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('finish');
      expect(headersOf(msg).finishReason).toBe('stop');
    });

    it('encodes error with errorText', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'error', errorText: 'something failed' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('error');
      expect(msg.data).toBe('something failed');
    });

    it('encodes abort as a plain discrete output and does not cancel streams', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'text-start', id: 'txt-1' });
      await encoder.publishOutput({ type: 'abort', reason: 'cancelled' });

      // abort is an ordinary discrete output: type:'abort', reason as data, and
      // NO status:cancelled header (that belongs on cancelled streams, not on
      // the abort content chunk).
      const abortMsg = lastPublish(writer);
      expect(abortMsg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(abortMsg).kind).toBe('abort');
      expect(abortMsg.data).toBe('cancelled');
      expect(headersOf(abortMsg)[HEADER_STATUS]).toBeUndefined();

      // Publishing an abort does NOT cancel the open stream — only
      // cancelStreams() does that.
      const cancelAppend = writer.appendCalls.find((m) => headersOf(m)[HEADER_STATUS] === 'cancelled');
      expect(cancelAppend).toBeUndefined();
    });

    it('cancelStreams() cancels all in-flight streams and publishes no abort', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'text-start', id: 'txt-1' });
      const publishCountBefore = writer.publishCalls.length;

      await encoder.cancelStreams();

      // The open stream is cancelled (status:cancelled append) ...
      const cancelAppend = writer.appendCalls.find((m) => headersOf(m)[HEADER_STATUS] === 'cancelled');
      expect(cancelAppend).toBeDefined();
      // ... and no abort discrete is published (cancelStreams is pure mechanics).
      expect(writer.publishCalls.length).toBe(publishCountBefore);
    });

    it('cancelStreams() is idempotent — a second call appends nothing', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'text-start', id: 'txt-1' });

      await encoder.cancelStreams();
      const appendCountAfterFirst = writer.appendCalls.length;

      await encoder.cancelStreams();
      expect(writer.appendCalls.length).toBe(appendCountAfterFirst);
    });

    it('cancelStreams() with no open streams is a no-op', async () => {
      const encoder = createEncoder(writer);
      await encoder.cancelStreams();

      expect(writer.publishCalls).toHaveLength(0);
      expect(writer.appendCalls).toHaveLength(0);
    });

    it('encodes start-step as a discrete message', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'start-step' });

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('start-step');
    });
  });

  // -- tool lifecycle events ------------------------------------------------

  describe('tool lifecycle events', () => {
    it('encodes tool-input-error', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({
        type: 'tool-input-error',
        toolCallId: 'tc-1',
        toolName: 'search',
        errorText: 'parse error',
        input: { bad: true },
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('tool-input-error');
      expect(msg.data).toEqual({ errorText: 'parse error', input: { bad: true } });
      expect(headersOf(msg).toolCallId).toBe('tc-1');
    });

    it('encodes tool-output-available', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { result: 42 },
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('tool-output-available');
      expect(msg.data).toEqual({ output: { result: 42 } });
    });

    it('encodes tool-output-error', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({
        type: 'tool-output-error',
        toolCallId: 'tc-1',
        errorText: 'timeout',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('tool-output-error');
      expect(msg.data).toEqual({ errorText: 'timeout' });
    });

    it('encodes tool-approval-request', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({
        type: 'tool-approval-request',
        toolCallId: 'tc-1',
        approvalId: 'apr-1',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('tool-approval-request');
      expect(headersOf(msg).toolCallId).toBe('tc-1');
      expect(headersOf(msg).approvalId).toBe('apr-1');
    });

    it('encodes tool-output-denied', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({
        type: 'tool-output-denied',
        toolCallId: 'tc-1',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('tool-output-denied');
    });
  });

  // -- content parts --------------------------------------------------------

  describe('content parts', () => {
    it('encodes file chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('file');
      expect(msg.data).toBe('https://example.com/img.png');
      expect(headersOf(msg).mediaType).toBe('image/png');
    });

    it('encodes source-url chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({
        type: 'source-url',
        sourceId: 'src-1',
        url: 'https://example.com',
        title: 'Example',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('source-url');
      expect(headersOf(msg).sourceId).toBe('src-1');
      expect(headersOf(msg).title).toBe('Example');
    });

    it('encodes source-document chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({
        type: 'source-document',
        sourceId: 'src-1',
        mediaType: 'application/pdf',
        title: 'Doc',
        filename: 'doc.pdf',
      });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('source-document');
      expect(headersOf(msg).filename).toBe('doc.pdf');
    });

    it('encodes message-metadata chunk', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'message-metadata', messageMetadata: { key: 'val' } });

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('message-metadata');
      expect(headersOf(msg).messageMetadata).toBe(JSON.stringify({ key: 'val' }));
    });
  });

  // -- data-* chunks --------------------------------------------------------

  describe('data-* chunks', () => {
    it('encodes data-* chunk as discrete', async () => {
      const encoder = createEncoder(writer);
      const chunk = { type: 'data-custom' as const, data: { foo: 'bar' }, id: 'dc-1' };
      await encoder.publishOutput(chunk);

      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('data-custom');
      expect(msg.data).toEqual({ foo: 'bar' });
      expect(headersOf(msg).id).toBe('dc-1');
    });

    it('marks transient data-* chunks as ephemeral', async () => {
      const encoder = createEncoder(writer);
      const chunk = { type: 'data-status' as const, data: undefined, transient: true };
      await encoder.publishOutput(chunk);

      const msg = firstPublish(writer);
      // CAST: Tests inspect the ephemeral field set by the encoder.
      const extras = msg.extras as { ephemeral?: boolean };
      expect(extras.ephemeral).toBe(true);
    });
  });

  // -- user message inputs (publishInput) -----------------------------------

  describe('publishing user-message inputs', () => {
    it('publishes UIMessage parts as discrete ai-input batch with kind: user-message and per-part partType', async () => {
      const encoder = createEncoder(writer);
      const msg: AI.UIMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' },
        ],
      };

      await encoder.publishInput({ kind: 'user-message', message: msg });

      // Should be a single batch publish with 2 messages
      expect(writer.publishCalls).toHaveLength(1);
      const call = writer.publishCalls[0];
      if (!Array.isArray(call)) throw new Error('expected batch publish');
      expect(call).toHaveLength(2);

      const first = call[0];
      expect(first?.name).toBe(EVENT_AI_INPUT);
      expect(first?.data).toBe('hello');
      if (first) {
        expect(headersOf(first).kind).toBe('user-message');
        expect(headersOf(first).partType).toBe('text');
        expect(headersOf(first).messageId).toBe('msg-1');
        expect(headersOf(first)[HEADER_DISCRETE]).toBe('true');
      }

      expect(call[1]?.name).toBe(EVENT_AI_INPUT);
      expect(call[1]?.data).toBe('https://example.com/img.png');
      if (call[1]) {
        expect(headersOf(call[1]).kind).toBe('user-message');
        expect(headersOf(call[1]).partType).toBe('file');
      }
    });

    it('round-trips a user-message: wire carries kind: user-message + partType, and the part reconstructs', async () => {
      const encoder = createEncoder(writer);
      const decoder = createDecoder();
      const msg: AI.UIMessage = {
        id: 'msg-rt',
        role: 'user',
        parts: [{ type: 'text', text: 'round trip' }],
      };

      await encoder.publishInput({ kind: 'user-message', message: msg });

      const wire = firstPublish(writer);
      // The SDK-controlled dispatch header is the uniform `kind`; the part type
      // rides the dedicated `partType` codec header (not the `kind` value).
      expect(headersOf(wire).kind).toBe('user-message');
      expect(headersOf(wire).partType).toBe('text');

      // Decode the encoded wire message back into a UIMessage. The encoded
      // Ably.Message and a decoded Ably.InboundMessage share the fields the
      // decoder reads (name, data, extras.ai.{transport,codec}); the inbound
      // `action` is supplied by Ably on receipt, so stamp the create action.
      // CAST: the encoder's Ably.Message plus an action satisfies the InboundMessage fields the decoder reads.
      const inbound = { ...wire, action: 'message.create' } as unknown as Ably.InboundMessage;
      const { inputs } = decoder.decode(inbound);
      expect(inputs).toHaveLength(1);
      const input = inputs[0];
      expect(input?.kind).toBe('user-message');
      if (input?.kind !== 'user-message') return;
      expect(input.message.id).toBe('msg-rt');
      expect(input.message.role).toBe('user');
      expect(input.message.parts).toEqual([{ type: 'text', text: 'round trip' }]);
    });

    it('publishes an empty text part for a message with no parts so the id and role survive', async () => {
      const encoder = createEncoder(writer);
      const msg: AI.UIMessage = { id: 'msg-1', role: 'user', parts: [] };

      await encoder.publishInput({ kind: 'user-message', message: msg });

      const call = writer.publishCalls[0];
      if (!Array.isArray(call)) throw new Error('expected batch publish');
      expect(call).toHaveLength(1);
      expect(call[0]?.name).toBe(EVENT_AI_INPUT);
      expect(call[0]?.data).toBe('');
      if (call[0]) {
        // An empty message falls back to one empty text part, so the codec-message-id
        // and role survive and it round-trips to a one-part message (unchanged wire).
        expect(headersOf(call[0]).kind).toBe('user-message');
        expect(headersOf(call[0]).partType).toBe('text');
        expect(headersOf(call[0]).messageId).toBe('msg-1');
        expect(headersOf(call[0])[HEADER_ROLE]).toBe('user');
      }
    });

    it('publishes the empty text fallback when every part is unmapped, so the message round-trips', async () => {
      const encoder = createEncoder(writer);
      // step-start has no wire mapping. Without the explode-level fallback the
      // batch would publish a bare-headers event with no partType, which the
      // decode side cannot round-trip — the message would silently vanish.
      const msg: AI.UIMessage = { id: 'msg-2', role: 'user', parts: [{ type: 'step-start' }] };

      await encoder.publishInput({ kind: 'user-message', message: msg });

      const call = writer.publishCalls[0];
      if (!Array.isArray(call)) throw new Error('expected batch publish');
      expect(call).toHaveLength(1);
      if (call[0]) {
        expect(headersOf(call[0]).kind).toBe('user-message');
        expect(headersOf(call[0]).partType).toBe('text');
        expect(headersOf(call[0]).messageId).toBe('msg-2');
        expect(headersOf(call[0])[HEADER_ROLE]).toBe('user');
      }
    });
  });

  // -- tool-approval-response inputs (publishInput) -------------------------

  describe('publishing tool-approval-response inputs', () => {
    it('publishes a discrete tool-approval-response with toolCallId/approved/reason headers and no amend header', async () => {
      const encoder = createEncoder(writer);
      // The encoder's per-write `messageId` carries the continuation's own
      // wire id — it is NOT used to target the original assistant.
      await encoder.publishInput(
        {
          kind: 'tool-approval-response',
          codecMessageId: 'msg-1',
          payload: { toolCallId: 'tc-1', approved: true, reason: 'looks good' },
        },
        { messageId: 'continuation-codec-message-id' },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_INPUT);
      expect(headersOf(msg).kind).toBe('tool-approval-response');
      expect(headersOf(msg).toolCallId).toBe('tc-1');
      expect(headersOf(msg).approved).toBe('true');
      expect(headersOf(msg).reason).toBe('looks good');
      // HEADER_CODEC_MESSAGE_ID comes from perWrite.messageId — the continuation's
      // own new wire id. The reducer routes to the original assistant by
      // toolCallId, not by codec-message-id.
      expect(headersOf(msg)[HEADER_CODEC_MESSAGE_ID]).toBe('continuation-codec-message-id');
      // No HEADER_AMEND on the wire — the amend concept has been retired.
      expect(headersOf(msg).amend).toBeUndefined();
    });
  });

  // -- regenerate inputs (publishInput) -------------------------------------

  describe('publishing regenerate inputs', () => {
    it('publishes a discrete regenerate wire with empty data; routing metadata travels on transport headers', async () => {
      const encoder = createEncoder(writer);
      // The client-session builds transport headers (codec-message-id, event-id,
      // run-id, parent, msg-regenerate, role) and passes them as
      // `extras.headers` on the per-write options. The encoder forwards
      // them onto the wire and carries no domain payload of its own.
      await encoder.publishInput(
        {
          kind: 'regenerate',
          target: 'asst-A1',
          parent: 'user-U1',
        },
        {
          messageId: 'regen-codec-message-id',
          extras: {
            headers: {
              [HEADER_CODEC_MESSAGE_ID]: 'regen-codec-message-id',
              'event-id': 'prompt-1',
              role: 'user',
              parent: 'user-U1',
              'msg-regenerate': 'asst-A1',
            },
          },
        },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_INPUT);
      expect(headersOf(msg).kind).toBe('regenerate');
      expect(msg.data).toBe('');
      const headers = headersOf(msg);
      expect(headers[HEADER_CODEC_MESSAGE_ID]).toBe('regen-codec-message-id');
      expect(headers['event-id']).toBe('prompt-1');
      expect(headers.role).toBe('user');
      expect(headers.parent).toBe('user-U1');
      expect(headers['msg-regenerate']).toBe('asst-A1');
    });
  });

  // -- client tool output inputs (publishInput → ai-input wire) -------------

  describe('publishing client tool output inputs', () => {
    it('publishes a tool-result input on the ai-input wire with codec-type: tool-result', async () => {
      const encoder = createEncoder(writer);
      // Client-published continuation tool results are first-class
      // VercelInputs and ride the `ai-input` wire (NOT `ai-output`).
      // HEADER_CODEC_MESSAGE_ID targets the assistant whose tool call
      // this result corresponds to.
      await encoder.publishInput(
        {
          kind: 'tool-result',
          codecMessageId: 'msg-1',
          payload: { toolCallId: 'tc-1', output: { latitude: 51.5, longitude: -0.1 } },
        },
        { messageId: 'continuation-codec-message-id' },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_INPUT);
      expect(headersOf(msg).kind).toBe('tool-result');
      expect(headersOf(msg).toolCallId).toBe('tc-1');
      expect(headersOf(msg)[HEADER_CODEC_MESSAGE_ID]).toBe('continuation-codec-message-id');
      expect(headersOf(msg).amend).toBeUndefined();
      // CAST: data is unknown — we know the encoder shape from above.
      const data = msg.data as { output: unknown };
      expect(data.output).toEqual({ latitude: 51.5, longitude: -0.1 });
    });

    it('publishes a tool-result-error input on the ai-input wire with codec-type: tool-result-error', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishInput(
        {
          kind: 'tool-result-error',
          codecMessageId: 'msg-1',
          payload: { toolCallId: 'tc-1', message: 'geolocation denied' },
        },
        { messageId: 'continuation-codec-message-id' },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_INPUT);
      expect(headersOf(msg).kind).toBe('tool-result-error');
      expect(headersOf(msg).toolCallId).toBe('tc-1');
      expect(headersOf(msg)[HEADER_CODEC_MESSAGE_ID]).toBe('continuation-codec-message-id');
      expect(headersOf(msg).amend).toBeUndefined();
      // CAST: data is unknown — we know the encoder shape from above.
      const data = msg.data as { message: string };
      expect(data.message).toBe('geolocation denied');
    });

    it('round-trips a fork-continuation forkSeed on a tool-result through encode then decode', async () => {
      const encoder = createEncoder(writer);
      const decoder = createDecoder();
      // A fork continuation carries a self-contained seed — the suspended run's
      // full message list under fresh codec-message-ids — so the agent's reducer
      // can reconstruct that run in the fork's own projection.
      const seed: ForkSeed = {
        messages: [
          {
            codecMessageId: 'fork-asst',
            message: {
              id: 'asst-tool',
              role: 'assistant',
              parts: [
                {
                  type: 'dynamic-tool',
                  toolName: 'getLocation',
                  toolCallId: 'tc-1',
                  state: 'input-available',
                  input: {},
                },
              ],
            },
          },
        ],
      };
      await encoder.publishInput(
        {
          kind: 'tool-result',
          codecMessageId: 'fork-asst',
          payload: { toolCallId: 'tc-1', output: { city: 'Hong Kong' }, forkSeed: seed },
        },
        { messageId: 'fork-continuation-id' },
      );

      const wire = firstPublish(writer);
      // CAST: the encoder's Ably.Message plus a create action satisfies the InboundMessage fields the decoder reads.
      const inbound = { ...wire, action: 'message.create' } as unknown as Ably.InboundMessage;
      const { inputs } = decoder.decode(inbound);
      expect(inputs).toHaveLength(1);
      const input = inputs[0];
      expect(input?.kind).toBe('tool-result');
      if (input?.kind !== 'tool-result') return;
      expect(input.payload.toolCallId).toBe('tc-1');
      expect(input.payload.output).toEqual({ city: 'Hong Kong' });
      // The seed survives the wire round-trip: its one message (fresh id + domain
      // id) and its tool-call part.
      expect(input.payload.forkSeed?.messages).toHaveLength(1);
      expect(input.payload.forkSeed?.messages[0]?.codecMessageId).toBe('fork-asst');
      expect(input.payload.forkSeed?.messages[0]?.message.id).toBe('asst-tool');
      expect(input.payload.forkSeed?.messages[0]?.message.parts).toEqual([
        { type: 'dynamic-tool', toolName: 'getLocation', toolCallId: 'tc-1', state: 'input-available', input: {} },
      ]);
    });

    it('drops a malformed forkSeed part on decode so it never reaches the reducer', async () => {
      // Trust boundary: a tool-result whose forkSeed carries a malformed part
      // (`[{}]` / `[null]` — no string `type`) must NOT crash the reducer. The
      // wire guard filters the bad parts out on decode; the surviving decoded
      // input then folds cleanly (the target simply pends for want of its tool
      // part — a graceful degradation, not a crash).
      const encoder = createEncoder(writer);
      const decoder = createDecoder();
      const malformedSeed = {
        messages: [
          // Deliberately malformed parts (an object with no `type`, and a null)
          // to exercise the wire trust boundary.
          // eslint-disable-next-line unicorn/no-null -- malformed wire data under test
          { codecMessageId: 'fork-asst', message: { id: 'asst-tool', role: 'assistant', parts: [{}, null] } },
        ],
      } as unknown as ForkSeed;
      await encoder.publishInput(
        {
          kind: 'tool-result',
          codecMessageId: 'fork-asst',
          payload: { toolCallId: 'tc-1', output: { city: 'Hong Kong' }, forkSeed: malformedSeed },
        },
        { messageId: 'fork-continuation-id' },
      );

      const wire = firstPublish(writer);
      // CAST: the encoder's Ably.Message plus a create action satisfies the InboundMessage fields the decoder reads.
      const inbound = { ...wire, action: 'message.create' } as unknown as Ably.InboundMessage;
      const { inputs } = decoder.decode(inbound);
      const input = inputs[0];
      expect(input?.kind).toBe('tool-result');
      if (input?.kind !== 'tool-result') return;
      // Both malformed parts were dropped by the wire guard.
      expect(input.payload.forkSeed?.messages[0]?.message.parts).toEqual([]);

      // Folding the decoded input into a fresh projection does not throw — the
      // reducer never sees a malformed part.
      expect(() =>
        UIMessageCodec.fold(UIMessageCodec.init(), { direction: 'input', event: input }, { serial: 's1' }),
      ).not.toThrow();
    });
  });

  // -- agent tool output chunks (publishOutput → ai-output wire) ------------

  describe('publishing agent tool output chunks', () => {
    it('publishes an agent-side tool-output-available UIMessageChunk on ai-output', async () => {
      const encoder = createEncoder(writer);
      // Agent-side tool-output-available remains a UIMessageChunk on the
      // `ai-output` wire — unchanged by the input/output split.
      await encoder.publishOutput(
        {
          type: 'tool-output-available',
          toolCallId: 'tc-1',
          output: { temp: 72 },
        },
        { messageId: 'msg-1' },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('tool-output-available');
      expect(headersOf(msg).toolCallId).toBe('tc-1');
      expect(headersOf(msg)[HEADER_CODEC_MESSAGE_ID]).toBe('msg-1');
      // CAST: data is unknown — we know the encoder shape from above.
      const data = msg.data as { output: unknown };
      expect(data.output).toEqual({ temp: 72 });
    });

    it('publishes an agent-side tool-output-error UIMessageChunk on ai-output', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput(
        {
          type: 'tool-output-error',
          toolCallId: 'tc-1',
          errorText: 'model error',
        },
        { messageId: 'msg-1' },
      );

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe(EVENT_AI_OUTPUT);
      expect(headersOf(msg).kind).toBe('tool-output-error');
      expect(headersOf(msg).toolCallId).toBe('tc-1');
    });
  });

  // -- wire-name uniformity ------------------------------------------------

  describe('ai-input wire name', () => {
    it('publishes every client-side codec input under the single ai-input wire name', async () => {
      const encoder = createEncoder(writer);

      const userMsg: AI.UIMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' },
          { type: 'data-custom', id: 'd-1', data: { x: 1 } },
        ],
      };
      await encoder.publishInput({ kind: 'user-message', message: userMsg });
      await encoder.publishInput({
        kind: 'tool-approval-response',
        codecMessageId: 'msg-1',
        payload: { toolCallId: 'tc-1', approved: true },
      });
      await encoder.publishInput({
        kind: 'tool-result',
        codecMessageId: 'msg-1',
        payload: { toolCallId: 'tc-1', output: { v: 1 } },
      });
      await encoder.publishInput({
        kind: 'tool-result-error',
        codecMessageId: 'msg-1',
        payload: { toolCallId: 'tc-1', message: 'x' },
      });
      await encoder.publishInput({
        kind: 'regenerate',
        target: 'asst-A1',
        parent: 'user-U1',
      });

      const allMessages: Ably.Message[] = [];
      for (const call of writer.publishCalls) {
        if (Array.isArray(call)) allMessages.push(...call);
        else allMessages.push(call);
      }
      expect(allMessages.length).toBeGreaterThan(0);
      for (const msg of allMessages) {
        expect(msg.name).toBe(EVENT_AI_INPUT);
        expect(headersOf(msg).kind).toBeDefined();
      }
    });
  });

  describe('ai-output wire name', () => {
    it('publishes every agent-side codec event under the single ai-output wire name', async () => {
      const encoder = createEncoder(writer);
      await encoder.publishOutput({ type: 'start', messageId: 'msg-1' });
      await encoder.publishOutput({ type: 'start-step' });
      await encoder.publishOutput({ type: 'text-start', id: 'txt-1' });
      await encoder.publishOutput({ type: 'text-end', id: 'txt-1' });
      await encoder.publishOutput({ type: 'reasoning-start', id: 'r-1' });
      await encoder.publishOutput({ type: 'reasoning-end', id: 'r-1' });
      await encoder.publishOutput({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' });
      await encoder.publishOutput({
        type: 'tool-input-available',
        toolCallId: 'tc-1',
        toolName: 'search',
        input: { q: 'x' },
      });
      await encoder.publishOutput({
        type: 'tool-input-error',
        toolCallId: 'tc-2',
        toolName: 'calc',
        errorText: 'bad',
        input: {},
      });
      await encoder.publishOutput({ type: 'tool-output-available', toolCallId: 'tc-1', output: {} });
      await encoder.publishOutput({ type: 'tool-output-error', toolCallId: 'tc-1', errorText: 'fail' });
      await encoder.publishOutput({ type: 'tool-approval-request', toolCallId: 'tc-1', approvalId: 'apr-1' });
      await encoder.publishOutput({ type: 'tool-output-denied', toolCallId: 'tc-1' });
      await encoder.publishOutput({ type: 'file', url: 'u', mediaType: 'image/png' });
      await encoder.publishOutput({ type: 'source-url', sourceId: 's', url: 'u' });
      await encoder.publishOutput({
        type: 'source-document',
        sourceId: 's',
        mediaType: 'application/pdf',
        title: 't',
      });
      await encoder.publishOutput({ type: 'message-metadata', messageMetadata: {} });
      await encoder.publishOutput({ type: 'finish-step' });
      await encoder.publishOutput({ type: 'finish', finishReason: 'stop' });
      await encoder.publishOutput({ type: 'error', errorText: 'x' });
      await encoder.publishOutput({ type: 'data-custom', data: { foo: 1 }, id: 'd-1' });

      // Every publish call (single or batch) must use the ai-output wire name.
      const allMessages: Ably.Message[] = [];
      for (const call of writer.publishCalls) {
        if (Array.isArray(call)) allMessages.push(...call);
        else allMessages.push(call);
      }
      expect(allMessages.length).toBeGreaterThan(0);
      for (const msg of allMessages) {
        expect(msg.name).toBe(EVENT_AI_OUTPUT);
        expect(headersOf(msg).kind).toBeDefined();
      }
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
