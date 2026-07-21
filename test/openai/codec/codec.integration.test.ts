/**
 * OpenAI ResponsesCodec integration test.
 *
 * Validates the encode -> publish -> subscribe -> decode -> fold roundtrip over a
 * real Ably channel (sandbox by default) for the streamed families — assistant
 * text, a reasoning summary, content-part discrimination (output_text + refusal),
 * and function-call arguments — plus the server-side tool call and the
 * user-message input path. Proves the wire format and Ably message append
 * semantics work end-to-end, without transport machinery.
 */

import type { Responses } from 'openai/resources/responses/responses';
import { afterEach, describe, expect, it } from 'vitest';

import { toCodecEvents } from '../../../src/core/codec/codec-event.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import { init, type OpenAIProjection } from '../../../src/openai/codec/reducer.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import {
  completed,
  contentPartAdded,
  firstInputText,
  functionCallArgsRun,
  functionCallItem,
  functionCallOutputEvent,
  itemAdded,
  itemDone,
  messageItem,
  metaOf,
  reasoningItem,
  reasoningSummaryPartAdded,
  reasoningSummaryTextDelta,
  reasoningSummaryTextDone,
  refusalDelta,
  refusalDone,
  refusalPartAdded,
  stampHeaders,
  textDelta,
  textDone,
  userTurn,
} from './fixtures.js';

describe('OpenAI ResponsesCodec integration', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('text response roundtrip', async () => {
    const channelName = uniqueChannelName('openai-text-roundtrip');
    const pubChannel = ablyRealtimeClient().channels.get(channelName);
    const subChannel = ablyRealtimeClient().channels.get(channelName);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();

    const messageId = 'msg-1';
    const itemId = 'item-1';

    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      for (const event of toCodecEvents(decoded)) projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      // Terminal events are off the wire (run outcome is out-of-band), so the
      // last content event stands in as the done-signal: here the text stream end.
      if (decoded.outputs.some((e) => e.type === 'response.output_text.done')) resolveDone();
    });

    const encoder = ResponsesCodec.createEncoder(pubChannel, { onMessage: stampHeaders('run-1', messageId) });

    await encoder.publishOutput(itemAdded(messageItem(itemId)));
    await encoder.publishOutput(contentPartAdded(itemId));
    // Fire-and-forget deltas: the encoder accumulates them internally and
    // flushes on close, so they need not block the publish sequence.
    void encoder.publishOutput(textDelta(itemId, 'Hello, '));
    void encoder.publishOutput(textDelta(itemId, 'world!'));
    await encoder.publishOutput(textDone(itemId, 'Hello, world!'));
    await encoder.publishOutput(completed());
    await encoder.close();

    await done;

    const messages = ResponsesCodec.getMessages(projection);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.role).toBe('assistant');
    const message = messages[0]?.message.items.find((i): i is Responses.ResponseOutputMessage => i.type === 'message');
    const part = message?.content.find((p) => p.type === 'output_text');
    expect(part?.type === 'output_text' ? part.text : '').toBe('Hello, world!');
  });

  it('tool call roundtrip', async () => {
    const channelName = uniqueChannelName('openai-tool-roundtrip');
    const pubChannel = ablyRealtimeClient().channels.get(channelName);
    const subChannel = ablyRealtimeClient().channels.get(channelName);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();

    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      for (const event of toCodecEvents(decoded)) projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      // Terminal events are off the wire; the call's result is the last content.
      if (decoded.outputs.some((e) => e.type === 'function_call_output')) resolveDone();
    });

    const call = functionCallItem('fc-1', 'call-1', 'getWeather', '{"location":"London"}', 'completed');
    const encoder = ResponsesCodec.createEncoder(pubChannel, { onMessage: stampHeaders('run-1', 'msg-1') });
    await encoder.publishOutput(itemAdded(call));
    await encoder.publishOutput(itemDone(call));
    await encoder.publishOutput(functionCallOutputEvent('call-1', '{"temperature":12}'));
    await encoder.publishOutput(completed());
    await encoder.close();

    await done;

    const items = ResponsesCodec.getMessages(projection)[0]?.message.items ?? [];
    expect(items.map((i) => i.type)).toEqual(['function_call', 'function_call_output']);
    const output = items.find(
      (i): i is Responses.ResponseInputItem.FunctionCallOutput => i.type === 'function_call_output',
    );
    expect(output?.call_id).toBe('call-1');
    expect(output?.output).toBe('{"temperature":12}');
  });

  it('reasoning summary roundtrip', async () => {
    const channelName = uniqueChannelName('openai-reasoning-summary-roundtrip');
    const pubChannel = ablyRealtimeClient().channels.get(channelName);
    const subChannel = ablyRealtimeClient().channels.get(channelName);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();

    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      for (const event of toCodecEvents(decoded)) projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      // Terminal events are off the wire; wait for the item's discrete output_item.done.
      if (decoded.outputs.some((e) => e.type === 'response.output_item.done')) resolveDone();
    });

    const itemId = 'rs-1';
    const encoder = ResponsesCodec.createEncoder(pubChannel, { onMessage: stampHeaders('run-1', 'msg-1') });
    await encoder.publishOutput(itemAdded(reasoningItem(itemId)));
    await encoder.publishOutput(reasoningSummaryPartAdded(itemId, 0));
    void encoder.publishOutput(reasoningSummaryTextDelta(itemId, 'Think', 0));
    void encoder.publishOutput(reasoningSummaryTextDelta(itemId, 'ing…', 0));
    await encoder.publishOutput(reasoningSummaryTextDone(itemId, 'Thinking…', 0));
    await encoder.publishOutput(itemDone(reasoningItem(itemId, [{ type: 'summary_text', text: 'Thinking…' }])));
    await encoder.publishOutput(completed());
    await encoder.close();

    await done;

    const item = ResponsesCodec.getMessages(projection)[0]?.message.items.find(
      (i): i is Responses.ResponseReasoningItem => i.type === 'reasoning',
    );
    expect(item?.summary).toEqual([{ type: 'summary_text', text: 'Thinking…' }]);
  });

  it('reasoning encrypted_content roundtrip (store:false stateless carrier)', async () => {
    const channelName = uniqueChannelName('openai-reasoning-encrypted-roundtrip');
    const pubChannel = ablyRealtimeClient().channels.get(channelName);
    const subChannel = ablyRealtimeClient().channels.get(channelName);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();

    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      for (const event of toCodecEvents(decoded)) projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      // Terminal events are off the wire; the slim output_item.done carries the blob.
      if (decoded.outputs.some((e) => e.type === 'response.output_item.done')) resolveDone();
    });

    const itemId = 'rs-enc-1';
    const encoder = ResponsesCodec.createEncoder(pubChannel, { onMessage: stampHeaders('run-1', 'msg-1') });
    // Seed the owner WITHOUT the blob; the slim `output_item.done` must carry it,
    // and it must survive the real Ably encode → publish → subscribe → decode.
    await encoder.publishOutput(itemAdded(reasoningItem(itemId)));
    await encoder.publishOutput(itemDone(reasoningItem(itemId, [], 'ENCRYPTED-BLOB')));
    await encoder.publishOutput(completed());
    await encoder.close();

    await done;

    const item = ResponsesCodec.getMessages(projection)[0]?.message.items.find(
      (i): i is Responses.ResponseReasoningItem => i.type === 'reasoning',
    );
    expect(item?.encrypted_content).toBe('ENCRYPTED-BLOB');
  });

  it('content-part discrimination roundtrip (output_text + refusal)', async () => {
    const channelName = uniqueChannelName('openai-content-part-roundtrip');
    const pubChannel = ablyRealtimeClient().channels.get(channelName);
    const subChannel = ablyRealtimeClient().channels.get(channelName);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();

    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      for (const event of toCodecEvents(decoded)) projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      // Terminal events are off the wire; the refusal (content[1]) is published
      // last, so its stream end stands in as the done-signal.
      if (decoded.outputs.some((e) => e.type === 'response.refusal.done')) resolveDone();
    });

    const itemId = 'msg-1';
    const encoder = ResponsesCodec.createEncoder(pubChannel, { onMessage: stampHeaders('run-1', 'msg-1') });
    await encoder.publishOutput(itemAdded(messageItem(itemId)));
    // Two content parts opened from the same content_part.added start type.
    await encoder.publishOutput(contentPartAdded(itemId, 0));
    await encoder.publishOutput(refusalPartAdded(itemId, 1));
    void encoder.publishOutput(textDelta(itemId, 'hello', 0));
    void encoder.publishOutput(refusalDelta(itemId, 'no', 1));
    await encoder.publishOutput(textDone(itemId, 'hello', 0));
    await encoder.publishOutput(refusalDone(itemId, 'no', 1));
    await encoder.publishOutput(completed());
    await encoder.close();

    await done;

    const message = ResponsesCodec.getMessages(projection)[0]?.message.items.find(
      (i): i is Responses.ResponseOutputMessage => i.type === 'message',
    );
    expect(message?.content).toEqual([
      { type: 'output_text', text: 'hello', annotations: [] },
      { type: 'refusal', refusal: 'no' },
    ]);
  });

  it('function-call arguments roundtrip', async () => {
    const channelName = uniqueChannelName('openai-fn-args-roundtrip');
    const pubChannel = ablyRealtimeClient().channels.get(channelName);
    const subChannel = ablyRealtimeClient().channels.get(channelName);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();

    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      for (const event of toCodecEvents(decoded)) projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      // Terminal events are off the wire; the run ends with the item's output_item.done.
      if (decoded.outputs.some((e) => e.type === 'response.output_item.done')) resolveDone();
    });

    const encoder = ResponsesCodec.createEncoder(pubChannel, { onMessage: stampHeaders('run-1', 'msg-1') });
    // output_item.added opens the stream, the arg deltas/done fill it, and
    // output_item.done carries the complete item.
    for (const event of functionCallArgsRun('fc-1', 'call-1', 'getWeather', '{"location":"London"}')) {
      await encoder.publishOutput(event);
    }
    await encoder.publishOutput(completed());
    await encoder.close();

    await done;

    const item = ResponsesCodec.getMessages(projection)[0]?.message.items.find(
      (i): i is Responses.ResponseFunctionToolCall => i.type === 'function_call',
    );
    expect(item?.arguments).toBe('{"location":"London"}');
    expect(item?.call_id).toBe('call-1');
  });

  it('user message roundtrip', async () => {
    const channelName = uniqueChannelName('openai-user-roundtrip');
    const pubChannel = ablyRealtimeClient().channels.get(channelName);
    const subChannel = ablyRealtimeClient().channels.get(channelName);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();

    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      for (const event of toCodecEvents(decoded)) projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      if (decoded.inputs.length > 0) resolveDone();
    });

    const encoder = ResponsesCodec.createEncoder(pubChannel, { onMessage: stampHeaders('run-1', 'u-1') });
    await encoder.publishInput(ResponsesCodec.createUserMessage(userTurn('what is the weather in London?')));
    await encoder.close();

    await done;

    const messages = ResponsesCodec.getMessages(projection);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.role).toBe('user');
    expect(firstInputText(messages[0]?.message)).toBe('what is the weather in London?');
  });
});
