/**
 * OpenAI wire-codec input tests — the public body union.
 *
 * The wire codec's `ai-input` table carries codec-defined bodies: an
 * `OpenAIMessage` for a new turn (a batch fan-out per content part), OpenAI's
 * own `function_call_output` item for a tool resolution (the whole item as
 * wire data), the codec-defined approval decision (field-mapped), and the
 * wire-only regenerate signal. These tests pin the encode/decode round-trip
 * of each, plus the trust-boundary throw for a malformed item body.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { EVENT_AI_INPUT } from '../../../src/constants.js';
import type { ChannelWriter } from '../../../src/core/codec/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { OpenAIMessage } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';

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

const codecHeadersOf = (msg: Ably.Message): Record<string, string> => {
  // CAST: tests inspect the extras the encoder built.
  const extras = msg.extras as { ai?: { codec?: Record<string, string> } };
  return extras.ai?.codec ?? {};
};

const asInbound = (msg: Ably.Message): Ably.InboundMessage =>
  // CAST: the encoder's Ably.Message plus an action satisfies the fields the decoder reads.
  ({ ...msg, action: 'message.create', serial: 's1', version: {} }) as unknown as Ably.InboundMessage;

const firstDiscrete = (writer: MockWriter): Ably.Message => {
  const call = writer.publishCalls[0];
  if (!call || Array.isArray(call)) throw new Error('expected discrete publish');
  return call;
};

describe('OpenAI wire-codec inputs', () => {
  it('round-trips a message body as a per-part batch', async () => {
    const writer = createMockWriter();
    const encoder = ResponsesCodec.createEncoder(writer);
    const message: OpenAIMessage = {
      role: 'user',
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    };

    await encoder.publishInput({ kind: 'message', payload: message });

    const call = writer.publishCalls[0];
    if (!Array.isArray(call)) throw new Error('expected batch publish');
    expect(call).toHaveLength(1);
    expect(call[0]?.name).toBe(EVENT_AI_INPUT);
    expect(call[0]?.data).toBe('hello');

    const decoder = ResponsesCodec.createDecoder();
    const first = call[0];
    if (!first) throw new Error('expected a wire message');
    const { inputs } = decoder.decode(asInbound(first));
    expect(inputs).toEqual([{ kind: 'message', payload: message }]);
  });

  it('round-trips a function_call_output item body verbatim', async () => {
    const writer = createMockWriter();
    const encoder = ResponsesCodec.createEncoder(writer);
    const item = { type: 'function_call_output' as const, call_id: 'call-1', output: '{"ok":true}' };

    await encoder.publishInput({ kind: 'item', payload: item }, { messageId: 'assistant-1' });

    const wire = firstDiscrete(writer);
    expect(codecHeadersOf(wire).kind).toBe('item');
    expect(wire.data).toEqual(item);

    const decoder = ResponsesCodec.createDecoder();
    const { inputs } = decoder.decode(asInbound(wire));
    expect(inputs).toEqual([{ kind: 'item', payload: item }]);
  });

  it('throws on a malformed item body at decode', () => {
    const decoder = ResponsesCodec.createDecoder();
    const wire = {
      name: EVENT_AI_INPUT,
      action: 'message.create',
      serial: 's1',
      version: {},
      data: { type: 'message', call_id: 'call-1' },
      extras: { ai: { transport: {}, codec: { kind: 'item' } } },
      // CAST: tests construct a minimal inbound stub.
    } as unknown as Ably.InboundMessage;

    expect(() => decoder.decode(wire)).toThrowErrorInfo({ code: ErrorCode.InvalidArgument });
  });

  it('round-trips an approval decision through the field mapping', async () => {
    const writer = createMockWriter();
    const encoder = ResponsesCodec.createEncoder(writer);

    await encoder.publishInput(
      { kind: 'approval', payload: { call_id: 'call-1', approved: true } },
      { messageId: 'assistant-1' },
    );

    const wire = firstDiscrete(writer);
    expect(codecHeadersOf(wire).kind).toBe('approval');
    expect(codecHeadersOf(wire).call_id).toBe('call-1');

    const decoder = ResponsesCodec.createDecoder();
    const { inputs } = decoder.decode(asInbound(wire));
    expect(inputs).toEqual([{ kind: 'approval', payload: { call_id: 'call-1', approved: true } }]);
  });

  it('rejects a message turn that is not exactly one message item', async () => {
    const writer = createMockWriter();
    const encoder = ResponsesCodec.createEncoder(writer);
    const message: OpenAIMessage = { role: 'user', items: [] };

    await expect(encoder.publishInput({ kind: 'message', payload: message })).rejects.toBeErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );
  });
});
