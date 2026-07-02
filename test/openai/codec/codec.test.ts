/**
 * OpenAI codec offline roundtrip: encode -> wire -> decode -> fold.
 *
 * Unit tier (mocks only). The {@link createBridge} mock `ChannelWriter` records
 * the encoder's publish/append operations and replays the `InboundMessage`
 * sequence a subscriber would see, fed back through the real decoder + reducer.
 * This exercises the encode and decode paths together without a network; the
 * real-Ably proof lives in `codec.integration.test.ts`.
 */

import type * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import { EVENT_AI_INPUT, HEADER_ROLE, HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../../src/constants.js';
import { toCodecEvents } from '../../../src/core/codec/codec-event.js';
import { ErrorCode } from '../../../src/errors.js';
import type { OpenAIOutput } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import { init, type OpenAIProjection } from '../../../src/openai/codec/reducer.js';
import { getCodecHeaders, getTransportHeaders } from '../../../src/utils.js';
import {
  completed,
  contentPartAdded,
  contentPartDone,
  createBridge,
  created,
  failed,
  firstInputText,
  functionCallArgsRun,
  functionCallItem,
  functionCallOutputEvent,
  incomplete,
  inProgress,
  itemAdded,
  itemDone,
  messageItem,
  metaOf,
  queued,
  reasoningItem,
  reasoningSummaryPartDone,
  reasoningSummaryRun,
  reasoningTextDelta,
  reasoningTextDone,
  reasoningTextPartAdded,
  refusalDelta,
  refusalDone,
  refusalPartAdded,
  stampHeaders,
  streamError,
  textDelta,
  textDone,
  textRun,
  userTurn,
} from './fixtures.js';

const transportOf = (m: Ably.InboundMessage): Record<string, string> => getTransportHeaders(m);

// Encode events through the bridge and return the decoded inbound + outputs.
const roundtrip = async (
  events: OpenAIOutput[],
): Promise<{ inbound: Ably.InboundMessage[]; outputs: OpenAIOutput[] }> => {
  const { writer, inbound } = createBridge();
  const encoder = ResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', 'run-1') });
  for (const event of events) await encoder.publishOutput(event);
  await encoder.close();
  const messages = inbound();
  const decoder = ResponsesCodec.createDecoder();
  const outputs = messages.flatMap((msg) => decoder.decode(msg).outputs);
  return { inbound: messages, outputs };
};

describe('OpenAI codec roundtrip (offline)', () => {
  it('streams text as a streamed message with string appends', async () => {
    const { inbound } = await roundtrip(textRun('msg_1', 'Hello, world!'));
    const streamCreate = inbound.find((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true');
    expect(streamCreate).toBeDefined();
    expect(streamCreate && transportOf(streamCreate)[HEADER_STATUS]).toBe('streaming');
    // The output_text stream id composes item_id + content_index.
    expect(streamCreate && transportOf(streamCreate)[HEADER_STREAM_ID]).toBe('msg_1:0');

    const appends = inbound.filter((m) => m.action === 'message.append' && m.serial === streamCreate?.serial);
    expect(appends.length).toBeGreaterThanOrEqual(2);
    expect(appends.every((m) => typeof m.data === 'string')).toBe(true);
    expect(appends.some((m) => transportOf(m)[HEADER_STATUS] === 'complete')).toBe(true);
  });

  it('publishes lifecycle/structural events as discrete messages (no status)', async () => {
    const { inbound } = await roundtrip(textRun('msg_1', 'Hi'));
    const discrete = inbound.filter((m) => transportOf(m)[HEADER_STREAM] === 'false');
    expect(discrete.length).toBeGreaterThanOrEqual(1);
    expect(discrete.every((m) => transportOf(m)[HEADER_STATUS] === undefined)).toBe(true);
  });

  it('decodes + folds the wire back into the assistant text turn', async () => {
    const { inbound } = await roundtrip(textRun('msg_1', 'Hello, world!'));
    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    for (const msg of inbound) {
      for (const event of toCodecEvents(decoder.decode(msg))) {
        projection = ResponsesCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: 'run-1' });
      }
    }
    const turn = ResponsesCodec.getMessages(projection)[0]?.message;
    expect(turn?.role).toBe('assistant');
    const message = turn?.items.find((i): i is Responses.ResponseOutputMessage => i.type === 'message');
    const part = message?.content.find((p) => p.type === 'output_text');
    expect(part?.type === 'output_text' ? part.text : '').toBe('Hello, world!');
  });

  it('streams a reasoning summary under a composite stream id and folds it back', async () => {
    const { inbound } = await roundtrip(reasoningSummaryRun('rs_1', 'Thinking…'));

    // Composite, summary-namespaced stream id (item_id + summary dimension +
    // summary_index) so it can't clash with a reasoning_text content slot.
    const streamCreate = inbound.find((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true');
    expect(streamCreate && transportOf(streamCreate)[HEADER_STREAM_ID]).toBe('rs_1:summary:0');

    // Decode + fold: the summary text lands in the reasoning item's summary[0].
    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    for (const msg of inbound) {
      for (const event of toCodecEvents(decoder.decode(msg))) {
        projection = ResponsesCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: 'run-1' });
      }
    }
    const item = ResponsesCodec.getMessages(projection)[0]?.message.items.find(
      (i): i is Responses.ResponseReasoningItem => i.type === 'reasoning',
    );
    expect(item?.summary).toEqual([{ type: 'summary_text', text: 'Thinking…' }]);
  });

  it('routes output_text and refusal on the shared content_part.added start, keyed by content_index', async () => {
    const { inbound } = await roundtrip([
      created(),
      itemAdded(messageItem('msg_1')),
      contentPartAdded('msg_1', 0), // opens output_text at content[0]
      refusalPartAdded('msg_1', 1), // opens refusal at content[1]
      textDelta('msg_1', 'hello', 0),
      refusalDelta('msg_1', 'no', 1),
      textDone('msg_1', 'hello', 0),
      refusalDone('msg_1', 'no', 1),
      completed(),
    ]);

    // Two distinct streams opened from one shared start type, under composite ids.
    const streamIds = inbound
      .filter((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true')
      .map((m) => transportOf(m)[HEADER_STREAM_ID]);
    expect(streamIds).toEqual(['msg_1:0', 'msg_1:1']);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    for (const msg of inbound) {
      for (const event of toCodecEvents(decoder.decode(msg))) {
        projection = ResponsesCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: 'run-1' });
      }
    }
    const message = ResponsesCodec.getMessages(projection)[0]?.message.items.find(
      (i): i is Responses.ResponseOutputMessage => i.type === 'message',
    );
    expect(message?.content).toEqual([
      { type: 'output_text', text: 'hello', annotations: [] },
      { type: 'refusal', refusal: 'no' },
    ]);
  });

  it('streams function-call arguments under the item id and folds them back', async () => {
    const { inbound } = await roundtrip([
      created(),
      ...functionCallArgsRun('fc_1', 'call_1', 'getWeather', '{"location":"London"}'),
      completed(),
    ]);

    // Cap 1 (relocate): the stream id is the item id (item.id on the start,
    // item_id on the deltas).
    const streamCreate = inbound.find((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true');
    expect(streamCreate && transportOf(streamCreate)[HEADER_STREAM_ID]).toBe('fc_1');

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    for (const msg of inbound) {
      for (const event of toCodecEvents(decoder.decode(msg))) {
        projection = ResponsesCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: 'run-1' });
      }
    }
    const item = ResponsesCodec.getMessages(projection)[0]?.message.items.find(
      (i): i is Responses.ResponseFunctionToolCall => i.type === 'function_call',
    );
    expect(item?.arguments).toBe('{"location":"London"}');
    // The envelope (call_id / name) survived via the carried item + output_item.done.
    expect(item?.call_id).toBe('call_1');
    expect(item?.name).toBe('getWeather');
  });

  it('declines to stream a non-function-call output_item.added (discrete envelope)', async () => {
    const { inbound } = await roundtrip([created(), itemAdded(messageItem('msg_1')), completed()]);

    // A message item is not a function_call, so its output_item.added is a plain
    // discrete envelope, not a stream start.
    expect(inbound.filter((m) => transportOf(m)[HEADER_STREAM] === 'true')).toHaveLength(0);
    const discreteKinds = inbound
      .filter((m) => transportOf(m)[HEADER_STREAM] === 'false')
      .map((m) => getCodecHeaders(m).kind);
    expect(discreteKinds).toContain('response.output_item.added');
  });

  it('streams reasoning text on a reasoning item under a composite id and folds it', async () => {
    const { inbound } = await roundtrip([
      created(),
      itemAdded(reasoningItem('rs_1')),
      reasoningTextPartAdded('rs_1', 0),
      reasoningTextDelta('rs_1', 'be', 0),
      reasoningTextDelta('rs_1', 'cause', 0),
      reasoningTextDone('rs_1', 'because', 0),
      completed(),
    ]);

    const streamCreate = inbound.find((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true');
    expect(streamCreate && transportOf(streamCreate)[HEADER_STREAM_ID]).toBe('rs_1:0');

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    for (const msg of inbound) {
      for (const event of toCodecEvents(decoder.decode(msg))) {
        projection = ResponsesCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: 'run-1' });
      }
    }
    const item = ResponsesCodec.getMessages(projection)[0]?.message.items.find(
      (i): i is Responses.ResponseReasoningItem => i.type === 'reasoning',
    );
    expect(item?.content).toEqual([{ type: 'reasoning_text', text: 'because' }]);
  });

  it('rejects a function-call output_item.added that carries no item id', async () => {
    const { writer } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', 'run-1') });
    // The item id is the stream's slot key; a streamed function_call without one
    // is malformed wire data and is rejected at the encode boundary.
    await expect(
      encoder.publishOutput(itemAdded({ type: 'function_call', call_id: 'c1', name: 'getWeather', arguments: '' })),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('roundtrips each discrete lifecycle/structural event through encode + decode', async () => {
    const item = messageItem('msg_1', [{ type: 'output_text', text: 'done', annotations: [] }]);
    const { outputs } = await roundtrip([
      created(),
      inProgress(),
      queued(),
      itemAdded(item),
      itemDone(item),
      contentPartDone('msg_1'),
      reasoningSummaryPartDone('rs_1'),
      incomplete(),
      failed('nope'),
      streamError('boom'),
      completed(),
    ]);

    const types = outputs.map((e) => e.type);
    for (const expected of [
      'response.created',
      'response.in_progress',
      'response.queued',
      'response.output_item.added',
      'response.output_item.done',
      'response.content_part.done',
      'response.reasoning_summary_part.done',
      'response.incomplete',
      'response.failed',
      'error',
      'response.completed',
    ]) {
      expect(types).toContain(expected);
    }

    // Spot-check that payloads survive the wire.
    const completedEvent = outputs.find((e) => e.type === 'response.completed');
    expect(completedEvent?.type === 'response.completed' ? completedEvent.response.status : '').toBe('completed');
    const failedEvent = outputs.find((e) => e.type === 'response.failed');
    expect(failedEvent?.type === 'response.failed' ? failedEvent.response.error?.message : '').toBe('nope');
    const added = outputs.find((e) => e.type === 'response.output_item.added');
    expect(added?.type === 'response.output_item.added' ? added.item.id : '').toBe('msg_1');
    const errorEvent = outputs.find((e) => e.type === 'error');
    expect(errorEvent?.type === 'error' ? errorEvent.message : '').toBe('boom');
  });

  it('throws on an unmodelled output event (safety net)', async () => {
    const { writer } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', 'run-1') });
    // A hosted-tool event (web search) the codec doesn't model: it must surface
    // loudly rather than being dropped, since it signals an opt-in feature we
    // don't support yet.
    await expect(
      encoder.publishOutput({
        type: 'response.web_search_call.searching',
        item_id: 'ws_1',
        output_index: 0,
        sequence_number: 0,
      }),
    ).rejects.toThrow(/unsupported event type 'response\.web_search_call\.searching'/);

    // output_text annotations are citations produced by the retrieval tools, so
    // they only appear alongside those opt-in tools and throw the same way.
    await expect(
      encoder.publishOutput({
        type: 'response.output_text.annotation.added',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        annotation_index: 0,
        annotation: {},
        sequence_number: 0,
      }),
    ).rejects.toThrow(/unsupported event type 'response\.output_text\.annotation\.added'/);
  });

  it('roundtrips a server-side function call and its output through the wire', async () => {
    const call = functionCallItem('fc_1', 'call_1', 'getWeather', '{"location":"London"}', 'completed');
    const { inbound } = await roundtrip([
      created(),
      itemAdded(call),
      itemDone(call),
      functionCallOutputEvent('call_1', '{"temperature":12}'),
      completed(),
    ]);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    for (const msg of inbound) {
      for (const event of toCodecEvents(decoder.decode(msg))) {
        projection = ResponsesCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: 'run-1' });
      }
    }
    const items = ResponsesCodec.getMessages(projection)[0]?.message.items ?? [];
    expect(items.map((i) => i.type)).toEqual(['function_call', 'function_call_output']);
    const callItem = items.find((i): i is Responses.ResponseFunctionToolCall => i.type === 'function_call');
    expect(callItem?.name).toBe('getWeather');
    expect(callItem?.arguments).toBe('{"location":"London"}');
    const output = items.find(
      (i): i is Responses.ResponseInputItem.FunctionCallOutput => i.type === 'function_call_output',
    );
    expect(output?.call_id).toBe('call_1');
    expect(output?.output).toBe('{"temperature":12}');
  });

  it('roundtrips a user message on the ai-input wire', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', 'u1') });
    await encoder.publishInput(ResponsesCodec.createUserMessage(userTurn('Hi there')));
    await encoder.close();

    const messages = inbound();
    const input = messages.find((m) => m.name === EVENT_AI_INPUT);
    expect(input).toBeDefined();
    expect(input && getCodecHeaders(input).kind).toBe('user-message');
    expect(input && getCodecHeaders(input).partType).toBe('input_text');
    expect(input && getTransportHeaders(input)[HEADER_ROLE]).toBe('user');
    expect(input?.data).toBe('Hi there');

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    for (const msg of messages) {
      for (const event of toCodecEvents(decoder.decode(msg))) {
        projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      }
    }
    const turn = ResponsesCodec.getMessages(projection)[0]?.message;
    expect(turn?.role).toBe('user');
    expect(firstInputText(turn)).toBe('Hi there');
  });

  it('publishes a regenerate signal as a wire-only input that folds to nothing', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', 'u1') });
    await encoder.publishInput(ResponsesCodec.createRegenerate('asst-1', 'user-1'));
    await encoder.close();

    const messages = inbound();
    const input = messages.find((m) => m.name === EVENT_AI_INPUT);
    expect(input).toBeDefined();
    expect(input && getCodecHeaders(input).kind).toBe('regenerate');

    // Wire-only: the decoder emits no input events, so the reducer never folds
    // it and the projection stays empty (the signal carries no message state).
    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    let inputCount = 0;
    for (const msg of messages) {
      const decoded = decoder.decode(msg);
      inputCount += decoded.inputs.length;
      for (const event of toCodecEvents(decoded)) {
        projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      }
    }
    expect(inputCount).toBe(0);
    expect(ResponsesCodec.getMessages(projection)).toHaveLength(0);
  });

  it('round-trips an empty prompt as a single empty text part', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', 'u1') });
    // A turn whose message has no content parts exercises explode's ≥1-part guarantee.
    await encoder.publishInput(
      ResponsesCodec.createUserMessage({ role: 'user', items: [{ type: 'message', role: 'user', content: [] }] }),
    );
    await encoder.close();

    const messages = inbound();
    const input = messages.find((m) => m.name === EVENT_AI_INPUT);
    expect(input && getCodecHeaders(input).partType).toBe('input_text');
    expect(input?.data).toBe('');

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    for (const msg of messages) {
      for (const event of toCodecEvents(decoder.decode(msg))) {
        projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      }
    }
    expect(firstInputText(ResponsesCodec.getMessages(projection)[0]?.message)).toBe('');
  });

  it('round-trips the turn role rather than defaulting it', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', 'u1') });
    // A non-'user' role would be masked by the 'user' fallback if the header
    // were mis-keyed, so round-tripping it proves the role is actually read.
    await encoder.publishInput(
      ResponsesCodec.createUserMessage({
        role: 'assistant',
        items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      }),
    );
    await encoder.close();

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();
    for (const msg of inbound()) {
      for (const event of toCodecEvents(decoder.decode(msg))) {
        projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      }
    }
    expect(ResponsesCodec.getMessages(projection)[0]?.message.role).toBe('assistant');
  });

  it('defaults the role to user when the role header is absent', () => {
    const decoder = ResponsesCodec.createDecoder();
    // CAST: a minimal inbound ai-input part with no role transport header, to
    // exercise assemble's `?? 'user'` fallback.
    const msg = {
      action: 'message.create',
      serial: 's1',
      version: { serial: 's1' },
      name: EVENT_AI_INPUT,
      data: 'hi',
      extras: { ai: { transport: {}, codec: { kind: 'user-message', partType: 'input_text' } } },
    } as unknown as Ably.InboundMessage;

    let projection: OpenAIProjection = init();
    for (const event of toCodecEvents(decoder.decode(msg))) {
      projection = ResponsesCodec.fold(projection, event, metaOf(msg));
    }
    expect(ResponsesCodec.getMessages(projection)[0]?.message.role).toBe('user');
  });
});
