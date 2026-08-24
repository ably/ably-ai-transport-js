/**
 * Vercel wire-codec input tests — the public body union.
 *
 * The wire codec's `ai-input` table carries codec-defined bodies: a
 * `UIMessage` for a new turn (a batch fan-out per part), the AI SDK's own
 * tool-output chunk for a tool resolution (the whole chunk as wire data), the
 * codec-defined approval decision (field-mapped), and the wire-only
 * regenerate signal. These tests pin the encode/decode round-trip of each,
 * plus the trust-boundary throw for a malformed chunk body.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import { EVENT_AI_INPUT, HEADER_ROLE, HEADER_TRANSPORT_MESSAGE_ID } from '../../../src/constants.js';
import type { ChannelWriter } from '../../../src/core/codec/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { createUIMessageCodec } from '../../../src/vercel/codec/index.js';

const codec = createUIMessageCodec();

interface MockWriter extends ChannelWriter {
  publishCalls: (Ably.Message | Ably.Message[])[];
}

const createMockWriter = (): MockWriter => {
  const mock: MockWriter = {
    publishCalls: [],
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock resolves synchronously
    publish: (message) => {
      mock.publishCalls.push(message);
      // CAST: the tests never read the publish result.
      return Promise.resolve({} as Ably.PublishResult);
    },
    // CAST: the tests never read the append/update results.
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock resolves synchronously
    appendMessage: () => Promise.resolve({} as Ably.UpdateDeleteResult),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock resolves synchronously
    updateMessage: () => Promise.resolve({} as Ably.UpdateDeleteResult),
  };
  return mock;
};

// Read the codec-tier headers off an encoded message.
const codecHeadersOf = (msg: Ably.Message): Record<string, string> => {
  // CAST: tests inspect the extras the encoder built.
  const extras = msg.extras as { ai?: { codec?: Record<string, string> } };
  return extras.ai?.codec ?? {};
};

// Turn an encoded message back into an inbound message for the decoder.
const asInbound = (msg: Ably.Message, transportHeaders?: Record<string, string>): Ably.InboundMessage => {
  // CAST: the encoder's Ably.Message plus an action satisfies the fields the decoder reads.
  const inbound = { ...msg, action: 'message.create', serial: 's1', version: {} } as unknown as Ably.InboundMessage;
  if (transportHeaders) {
    // CAST: tests extend the extras the encoder built.
    const extras = inbound.extras as { ai: { transport?: Record<string, string> } };
    extras.ai.transport = { ...extras.ai.transport, ...transportHeaders };
  }
  return inbound;
};

const firstBatch = (writer: MockWriter): Ably.Message[] => {
  const call = writer.publishCalls[0];
  if (!Array.isArray(call)) throw new Error('expected batch publish');
  return call;
};

const firstDiscrete = (writer: MockWriter): Ably.Message => {
  const call = writer.publishCalls[0];
  if (!call || Array.isArray(call)) throw new Error('expected discrete publish');
  return call;
};

describe('Vercel wire-codec inputs', () => {
  it('round-trips a message body as a per-part batch', async () => {
    const writer = createMockWriter();
    const encoder = codec.createEncoder(writer);
    const message: AI.UIMessage = {
      id: 'm1',
      role: 'user',
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'file', url: 'https://example.com/a.png', mediaType: 'image/png' },
      ],
    };

    await encoder.publishInput({ kind: 'message', payload: message });

    const batch = firstBatch(writer);
    expect(batch).toHaveLength(2);
    expect(batch[0]?.name).toBe(EVENT_AI_INPUT);
    expect(batch.map((m) => codecHeadersOf(m).kind)).toEqual(['message', 'message']);
    expect(batch.map((m) => codecHeadersOf(m).partType)).toEqual(['text', 'file']);

    const decoder = codec.createDecoder();
    const decoded = batch.flatMap((m) => decoder.decode(asInbound(m)).inputs);
    expect(decoded).toHaveLength(2);
    for (const input of decoded) {
      expect(input.kind).toBe('message');
      if (input.kind !== 'message') continue;
      expect(input.payload.id).toBe('m1');
      expect(input.payload.role).toBe('user');
    }
    // A consumer merging the parts by transport-message-id gets the whole message back.
    const parts = decoded.flatMap((input) => (input.kind === 'message' ? input.payload.parts : []));
    expect(parts).toEqual(message.parts);
  });

  it('round-trips a tool-output chunk body verbatim', async () => {
    const writer = createMockWriter();
    const encoder = codec.createEncoder(writer);
    const chunk = { type: 'tool-output-available' as const, toolCallId: 'tc-1', output: { ok: true } };

    await encoder.publishInput({ kind: 'chunk', payload: chunk }, { messageId: 'assistant-1' });

    const wire = firstDiscrete(writer);
    expect(codecHeadersOf(wire).kind).toBe('chunk');
    expect(wire.data).toEqual(chunk);

    const decoder = codec.createDecoder();
    const { inputs } = decoder.decode(asInbound(wire, { [HEADER_TRANSPORT_MESSAGE_ID]: 'assistant-1' }));
    expect(inputs).toEqual([{ kind: 'chunk', payload: chunk }]);
  });

  it('throws on a malformed chunk body at decode', () => {
    const decoder = codec.createDecoder();
    const wire = {
      name: EVENT_AI_INPUT,
      action: 'message.create',
      serial: 's1',
      version: {},
      data: { type: 'not-a-tool-output', toolCallId: 'tc-1' },
      extras: { ai: { transport: {}, codec: { kind: 'chunk' } } },
      // CAST: tests construct a minimal inbound stub.
    } as unknown as Ably.InboundMessage;

    expect(() => decoder.decode(wire)).toThrowErrorInfo({ code: ErrorCode.InvalidArgument });
  });

  it('round-trips an approval decision through the field mapping', async () => {
    const writer = createMockWriter();
    const encoder = codec.createEncoder(writer);

    await encoder.publishInput(
      { kind: 'approval', payload: { toolCallId: 'tc-1', approved: false, reason: 'nope' } },
      { messageId: 'assistant-1' },
    );

    const wire = firstDiscrete(writer);
    expect(codecHeadersOf(wire).kind).toBe('approval');
    expect(codecHeadersOf(wire).toolCallId).toBe('tc-1');

    const decoder = codec.createDecoder();
    const { inputs } = decoder.decode(asInbound(wire));
    expect(inputs).toEqual([{ kind: 'approval', payload: { toolCallId: 'tc-1', approved: false, reason: 'nope' } }]);
  });

  it('publishes regenerate as a wire-only signal that decodes to nothing', async () => {
    const writer = createMockWriter();
    const encoder = codec.createEncoder(writer);

    await encoder.publishInput({ kind: 'regenerate' });

    const wire = firstDiscrete(writer);
    expect(codecHeadersOf(wire).kind).toBe('regenerate');
    expect(wire.data).toBe('');

    const decoder = codec.createDecoder();
    expect(decoder.decode(asInbound(wire)).inputs).toEqual([]);
  });

  it('publishes the empty text fallback for a message with no encodable parts', async () => {
    const writer = createMockWriter();
    const encoder = codec.createEncoder(writer);
    const message: AI.UIMessage = { id: 'm2', role: 'user', parts: [{ type: 'step-start' }] };

    await encoder.publishInput({ kind: 'message', payload: message });

    const batch = firstBatch(writer);
    expect(batch).toHaveLength(1);
    expect(batch[0]?.data).toBe('');
    if (batch[0]) {
      expect(codecHeadersOf(batch[0]).partType).toBe('text');
      // CAST: tests inspect the extras the encoder built.
      const extras = batch[0].extras as { ai?: { transport?: Record<string, string> } };
      expect(extras.ai?.transport?.[HEADER_ROLE]).toBe('user');
    }
  });
});
