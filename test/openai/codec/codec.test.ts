/**
 * OpenAI codec offline roundtrip: encode -> wire -> decode.
 *
 * Unit tier (mocks only). The {@link createBridge} mock `ChannelWriter` records
 * the encoder's publish/append operations and replays the `InboundMessage`
 * sequence a subscriber would see, fed back through the real decoder. The
 * assertions cover the wire contract from both sides: the raw wire messages
 * the encoder publishes (headers, stream ids, data envelopes) and the decoded
 * event sequences a subscriber reconstructs.
 */

import type * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import { EVENT_AI_INPUT, HEADER_ROLE, HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../../src/constants.js';
import { ErrorCode } from '../../../src/errors.js';
import type { OpenAIInput, OpenAIMessage, OpenAIOutput } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import { getCodecHeaders, getTransportHeaders } from '../../../src/utils.js';
import {
  completed,
  computerCallOutputItem,
  contentPartAdded,
  contentPartDone,
  createBridge,
  created,
  eventsOfType,
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
  toolApprovalRequestEvent,
  userTurn,
} from './fixtures.js';

const transportOf = (m: Ably.InboundMessage): Record<string, string> => getTransportHeaders(m);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// The raw wire `data` the encoder published for the first message of `kind` —
// what a subscriber sees BEFORE any decode.
const wireData = (inbound: Ably.InboundMessage[], kind: string): unknown =>
  inbound.find((m) => getCodecHeaders(m).kind === kind)?.data;

// The item the encoder put on the wire for the discrete output_item.done event,
// read out of its `{ item }` data envelope (see the envelope note in
// descriptors.ts; the framing itself is asserted separately below). Asserting on
// it proves the encoder itself reduced the item to its wire form, independently
// of the decoder — which just reads the same `item` field back.
const wireDoneItem = (inbound: Ably.InboundMessage[]): unknown => {
  const data = wireData(inbound, 'response.output_item.done');
  return isRecord(data) ? data.item : undefined;
};

// Encode events through the bridge and return the decoded inbound + outputs.
// Events are fed to the encoder as-is — exactly what an agent's pipe does —
// and the codec's descriptor table curates the wire (its drop entries encode
// the framing events to nothing).
const roundtrip = async (
  events: OpenAIOutput[],
): Promise<{ inbound: Ably.InboundMessage[]; outputs: OpenAIOutput[] }> => {
  const { writer, inbound } = createBridge();
  const encoder = ResponsesCodec.createEncoder(writer, { onAblyMessage: stampHeaders('run-x', 'run-1') });
  for (const event of events) await encoder.publishOutput(event);
  await encoder.close();
  const messages = inbound();
  const decoder = ResponsesCodec.createDecoder();
  const outputs = messages.flatMap((msg) => decoder.decode(msg).outputs);
  return { inbound: messages, outputs };
};

// Decode a whole inbound sequence's output events through a fresh decoder.
const decodeOutputs = (messages: Ably.InboundMessage[]): OpenAIOutput[] => {
  const decoder = ResponsesCodec.createDecoder();
  return messages.flatMap((msg) => decoder.decode(msg).outputs);
};

// Decode a whole inbound sequence's input events through a fresh decoder.
const decodeInputs = (messages: Ably.InboundMessage[]): OpenAIInput[] => {
  const decoder = ResponsesCodec.createDecoder();
  return messages.flatMap((msg) => decoder.decode(msg).inputs);
};

// The first decoded message-turn payload of a wire sequence, or undefined
// when no message input decodes.
const decodedMessagePayload = (messages: Ably.InboundMessage[]): OpenAIMessage | undefined => {
  const first = decodeInputs(messages)[0];
  return first?.kind === 'message' ? first.payload : undefined;
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

  it('decodes the wire back into the assistant text event sequence', async () => {
    const { outputs } = await roundtrip(textRun('msg_1', 'Hello, world!'));
    const types = outputs.map((e) => e.type);

    // The item envelope leads, then the content-part opener, then the streamed
    // text, then the closes — the (start, delta*, end) bracket a consumer folds.
    expect(types).toContain('response.content_part.added');
    expect(types).toContain('response.output_item.done');
    expect(types.indexOf('response.output_item.added')).toBeLessThan(types.indexOf('response.content_part.added'));
    expect(types.indexOf('response.content_part.added')).toBeLessThan(types.indexOf('response.output_text.delta'));
    expect(types.indexOf('response.output_text.delta')).toBeLessThan(types.indexOf('response.output_text.done'));
    expect(types.indexOf('response.output_text.done')).toBeLessThan(types.indexOf('response.output_item.done'));

    const added = eventsOfType(outputs, 'response.output_item.added')[0];
    expect(added?.item).toMatchObject({ type: 'message', id: 'msg_1' });

    // The deltas carry the full text, and the reconstructed done accumulates it.
    const deltas = eventsOfType(outputs, 'response.output_text.delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('Hello, world!');
    const done = eventsOfType(outputs, 'response.output_text.done')[0];
    expect(done).toMatchObject({ item_id: 'msg_1', content_index: 0, text: 'Hello, world!' });
  });

  it('streams a reasoning summary under a composite stream id and decodes the accumulated text', async () => {
    const { inbound, outputs } = await roundtrip(reasoningSummaryRun('rs_1', 'Thinking…'));

    // Composite, summary-namespaced stream id (item_id + summary dimension +
    // summary_index) so it can't clash with a reasoning_text content slot.
    const streamCreate = inbound.find((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true');
    expect(streamCreate && transportOf(streamCreate)[HEADER_STREAM_ID]).toBe('rs_1:summary:0');

    // The reconstructed done carries the accumulated summary text, addressed to
    // its item and summary slot via the re-stamped headers.
    const done = eventsOfType(outputs, 'response.reasoning_summary_text.done')[0];
    expect(done).toMatchObject({ item_id: 'rs_1', summary_index: 0, text: 'Thinking…' });
  });

  it('routes output_text and refusal on the shared content_part.added start, keyed by content_index', async () => {
    const { inbound, outputs } = await roundtrip([
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

    // Each stream decodes its own opener and reconstructs its own done, each
    // addressed to its content slot.
    const starts = eventsOfType(outputs, 'response.content_part.added');
    expect(starts.map((s) => s.part.type)).toEqual(['output_text', 'refusal']);
    const doneText = eventsOfType(outputs, 'response.output_text.done')[0];
    expect(doneText).toMatchObject({ item_id: 'msg_1', content_index: 0, text: 'hello' });
    const doneRefusal = eventsOfType(outputs, 'response.refusal.done')[0];
    expect(doneRefusal).toMatchObject({ item_id: 'msg_1', content_index: 1, refusal: 'no' });
  });

  it("round-trips output_item.done's message logprobs on the decoded wire-form item", async () => {
    // The rich, finalised-part logprobs shape (with `bytes`) — the shape
    // `ResponseOutputText.logprobs` wants — carried on output_item.done's item,
    // the one place the wire carries logprobs (see toWireItem in descriptors.ts).
    const logprobs: Responses.ResponseOutputText['logprobs'] = [
      { token: 'Hi', logprob: -0.1, bytes: [72, 105], top_logprobs: [] },
    ];
    const finalPart: Responses.ResponseOutputText = { type: 'output_text', text: 'Hi', annotations: [], logprobs };
    const { outputs } = await roundtrip([
      itemAdded(messageItem('msg_1')),
      contentPartAdded('msg_1'),
      textDelta('msg_1', 'Hi'),
      textDone('msg_1', 'Hi'),
      itemDone(messageItem('msg_1', [finalPart])),
      completed(),
    ]);

    // The decoded done item carries the logprobs residue index-aligned with the
    // message content; the streamed text itself is not re-echoed.
    const done = eventsOfType(outputs, 'response.output_item.done')[0];
    expect(done?.item).toEqual({
      type: 'message',
      id: 'msg_1',
      status: 'in_progress',
      content: [{ type: 'output_text', logprobs }],
    });
  });

  it('decodes output_item.done for a message as a lean item (no content) when logprobs were not requested', async () => {
    // Wire economy: a reply without logprobs reduces output_item.done to
    // { id, type, status } — no `content` array — on the decoded event.
    const doneItem = messageItem('msg_1', [{ type: 'output_text', text: 'Hi', annotations: [] }]);

    // Precondition: the item carries the content the wire strips, so the lean-item
    // assertion below can't pass merely because the fixture was already lean.
    expect(doneItem.content.length).toBeGreaterThan(0);

    const { outputs } = await roundtrip([
      itemAdded(messageItem('msg_1')),
      contentPartAdded('msg_1'),
      textDelta('msg_1', 'Hi'),
      textDone('msg_1', 'Hi'),
      itemDone(doneItem),
      completed(),
    ]);
    const done = eventsOfType(outputs, 'response.output_item.done')[0];
    expect(done?.item).toEqual({ type: 'message', id: 'msg_1', status: 'in_progress' });
  });

  it('streams function-call arguments under the item id and decodes the accumulated arguments', async () => {
    const { inbound, outputs } = await roundtrip([
      created(),
      ...functionCallArgsRun('fc_1', 'call_1', 'getWeather', '{"location":"London"}'),
      completed(),
    ]);

    // The stream id is the item id: item.id on the start, item_id on the deltas.
    const streamCreate = inbound.find((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true');
    expect(streamCreate && transportOf(streamCreate)[HEADER_STREAM_ID]).toBe('fc_1');

    // The stream start reconstructs the output_item.added carrying the item
    // envelope, so call_id / name survive on the item carried by the start
    // header (fItem), not the wire-form output_item.done.
    const added = eventsOfType(outputs, 'response.output_item.added');
    expect(added).toHaveLength(1);
    expect(added[0]?.item).toMatchObject({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'getWeather' });

    // The deltas carry the full arguments, and the reconstructed done accumulates them.
    const deltas = eventsOfType(outputs, 'response.function_call_arguments.delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('{"location":"London"}');
    const done = eventsOfType(outputs, 'response.function_call_arguments.done')[0];
    expect(done).toMatchObject({ item_id: 'fc_1', name: 'getWeather', arguments: '{"location":"London"}' });
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

  it('streams reasoning text on a reasoning item under a composite id and decodes the accumulated text', async () => {
    const { inbound, outputs } = await roundtrip([
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

    const done = eventsOfType(outputs, 'response.reasoning_text.done')[0];
    expect(done).toMatchObject({ item_id: 'rs_1', content_index: 0, text: 'because' });
  });

  it('preserves a reasoning item encrypted_content across the wire (store:false round-trip)', async () => {
    // encrypted_content is done-only and never streamed; seed the opening bracket via
    // `added` WITHOUT it so this proves the wire-form output_item.done carries it.
    const { outputs } = await roundtrip([
      created(),
      itemAdded(reasoningItem('rs_1')),
      itemDone(reasoningItem('rs_1', [], 'ENCRYPTED-BLOB')),
      completed(),
    ]);

    const done = eventsOfType(outputs, 'response.output_item.done')[0];
    const item = done?.item;
    expect(item?.type).toBe('reasoning');
    expect(item?.type === 'reasoning' ? item.encrypted_content : undefined).toBe('ENCRYPTED-BLOB');
  });

  it('rejects a function-call output_item.added that carries no item id', async () => {
    const { writer } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onAblyMessage: stampHeaders('run-x', 'run-1') });
    // The item id is the stream's slot key; a streamed function_call without one
    // is malformed wire data and is rejected at the encode boundary.
    await expect(
      encoder.publishOutput(itemAdded({ type: 'function_call', call_id: 'c1', name: 'getWeather', arguments: '' })),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('roundtrips the transmitted discrete events and drops the framing events at encode', async () => {
    const item = messageItem('msg_1', [{ type: 'output_text', text: 'done', annotations: [] }]);
    const { inbound, outputs } = await roundtrip([
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

    // The transmitted discrete events round-trip through encode + decode; the
    // framing events fed in are dropped by the codec's descriptor table at
    // encode, so no wire message carries them.
    const types = outputs.map((e) => e.type);
    for (const expected of ['response.output_item.added', 'response.output_item.done']) {
      expect(types).toContain(expected);
    }
    const wireKinds = inbound.map((m) => getCodecHeaders(m).kind ?? '');
    for (const dropped of [
      'response.created',
      'response.in_progress',
      'response.queued',
      'error',
      'response.content_part.done',
      'response.reasoning_summary_part.done',
      // The terminal events carry no state a wire consumer reads (run outcome is
      // observed out-of-band via the transport run-end event), so they are
      // dropped at encode alongside the openers — never on the wire, never decoded.
      'response.completed',
      'response.incomplete',
      'response.failed',
    ]) {
      expect(wireKinds).not.toContain(dropped);
    }
    for (const terminal of ['response.completed', 'response.incomplete', 'response.failed']) {
      expect(types).not.toContain(terminal);
    }

    // The kept item envelope survives with its id.
    const added = outputs.find((e) => e.type === 'response.output_item.added');
    expect(added?.type === 'response.output_item.added' ? added.item.id : '').toBe('msg_1');
  });

  it('throws on an unmodelled output event (safety net)', async () => {
    const { writer } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onAblyMessage: stampHeaders('run-x', 'run-1') });
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

  it('throws on an unmodelled output item type at encode (added and done)', async () => {
    const { writer } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onAblyMessage: stampHeaders('run-x', 'run-1') });
    // A computer_call_output is a ResponseOutputItem member the codec does not
    // model (and not a valid ResponseInputItem). The item envelope is carried on
    // output_item.added / .done, whose encode asserts the item is modelled, so an
    // undescribed item type fails loudly at the agent before it reaches the wire.
    await expect(encoder.publishOutput(itemAdded(computerCallOutputItem()))).rejects.toThrow(
      /unsupported output item type 'computer_call_output'/,
    );
    await expect(encoder.publishOutput(itemDone(computerCallOutputItem()))).rejects.toBeErrorInfo({
      code: ErrorCode.InvalidArgument,
      message: "unable to publish; unsupported output item type 'computer_call_output'",
    });
  });

  it('drops the framing events silently at encode (no publish, no throw)', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onAblyMessage: stampHeaders('run-x', 'run-1') });
    // The codec's drop entries: each encodes to nothing, unlike an undescribed
    // event (which throws — see the safety-net test above).
    await encoder.publishOutput(created());
    await encoder.publishOutput(inProgress());
    await encoder.publishOutput(queued());
    await encoder.publishOutput(streamError('boom'));
    await encoder.publishOutput(contentPartDone('msg_1'));
    await encoder.publishOutput(reasoningSummaryPartDone('rs_1'));
    // The terminal events are dropped too: run outcome travels out-of-band.
    await encoder.publishOutput(incomplete());
    await encoder.publishOutput(failed('nope'));
    await encoder.publishOutput(completed());
    await encoder.close();
    expect(inbound()).toHaveLength(0);
  });

  it('roundtrips a server-side function call and its output through the wire', async () => {
    const call = functionCallItem('fc_1', 'call_1', 'getWeather', '{"location":"London"}', 'completed');
    const { outputs } = await roundtrip([
      created(),
      itemAdded(call),
      itemDone(call),
      functionCallOutputEvent('call_1', '{"temperature":12}'),
      completed(),
    ]);

    // The call arrives as the stream start's item envelope; its result as the
    // codec's own function_call_output event, paired by call_id.
    const added = eventsOfType(outputs, 'response.output_item.added')[0];
    expect(added?.item).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'getWeather',
      arguments: '{"location":"London"}',
    });
    const output = eventsOfType(outputs, 'function_call_output')[0];
    expect(output?.item).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"temperature":12}' });
    // The discrete done reduces to the finalised status.
    const done = eventsOfType(outputs, 'response.output_item.done')[0];
    expect(done?.item).toEqual({ type: 'function_call', id: 'fc_1', status: 'completed' });

    const types = outputs.map((e) => e.type);
    expect(types.indexOf('response.output_item.added')).toBeLessThan(types.indexOf('function_call_output'));
  });

  it('roundtrips a user message on the ai-input wire', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer);
    await encoder.publishInput({ kind: 'message', payload: userTurn('Hi there') });
    await encoder.close();

    const messages = inbound();
    const input = messages.find((m) => m.name === EVENT_AI_INPUT);
    expect(input).toBeDefined();
    expect(input && getCodecHeaders(input).kind).toBe('message');
    expect(input && getCodecHeaders(input).partType).toBe('input_text');
    expect(input && getTransportHeaders(input)[HEADER_ROLE]).toBe('user');
    expect(input?.data).toBe('Hi there');

    expect(decodeInputs(messages)).toEqual([{ kind: 'message', payload: userTurn('Hi there') }]);
  });

  it('publishes a regenerate signal as a wire-only input that decodes to no events', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer);
    await encoder.publishInput({ kind: 'regenerate' });
    await encoder.close();

    const messages = inbound();
    const input = messages.find((m) => m.name === EVENT_AI_INPUT);
    expect(input).toBeDefined();
    expect(input && getCodecHeaders(input).kind).toBe('regenerate');

    // Wire-only: the signal carries no message state, so the decoder emits no
    // input events for it — the agent reads its targeting off the wire headers.
    expect(decodeInputs(messages)).toEqual([]);
  });

  it('round-trips an empty prompt as a single empty text part', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer);
    // A turn whose message has no content parts exercises explode's ≥1-part guarantee.
    await encoder.publishInput({
      kind: 'message',
      payload: { role: 'user', items: [{ type: 'message', role: 'user', content: [] }] },
    });
    await encoder.close();

    const messages = inbound();
    const input = messages.find((m) => m.name === EVENT_AI_INPUT);
    expect(input && getCodecHeaders(input).partType).toBe('input_text');
    expect(input?.data).toBe('');

    expect(firstInputText(decodedMessagePayload(messages))).toBe('');
  });

  it('rejects a user turn with more than one message item', async () => {
    const { writer } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer);
    // The fan-out carries no item boundary, so more than one message item
    // can't be represented on the wire — reject rather than silently
    // collapsing them into one.
    await expect(
      encoder.publishInput({
        kind: 'message',
        payload: {
          role: 'user',
          items: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'one' }] },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'two' }] },
          ],
        },
      }),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('rejects a user turn whose sole item is not a message', async () => {
    const { writer } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer);
    // Only a message item is a valid user turn; any other item type is a
    // genuine caller bug on the encode side and is rejected rather than skipped.
    await expect(
      encoder.publishInput({
        kind: 'message',
        payload: { role: 'user', items: [functionCallItem('fc_1', 'call_1', 'getWeather')] },
      }),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('rejects a content part type that we currently do not handle', async () => {
    const { writer } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer);
    // input_text is the only content part type this version of the codec
    // handles; any other part type is a genuine caller bug on the encode
    // side (e.g. an input_image sent before AIT-1120 lands) and is rejected
    // rather than silently dropped.
    await expect(
      encoder.publishInput({
        kind: 'message',
        payload: {
          role: 'user',
          items: [{ type: 'message', role: 'user', content: [{ type: 'input_image', detail: 'auto' }] }],
        },
      }),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('round-trips the turn role rather than defaulting it', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer);
    // A non-'user' role would be masked by the 'user' fallback if the header
    // were mis-keyed, so round-tripping it proves the role is actually read.
    await encoder.publishInput({
      kind: 'message',
      payload: {
        role: 'assistant',
        items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      },
    });
    await encoder.close();

    expect(decodedMessagePayload(inbound())?.role).toBe('assistant');
  });

  it('defaults the role to user when the role header is absent', () => {
    // CAST: a minimal inbound ai-input part with no role transport header, to
    // exercise assemble's `?? 'user'` fallback.
    const msg = {
      action: 'message.create',
      serial: 's1',
      version: { serial: 's1' },
      name: EVENT_AI_INPUT,
      data: 'hi',
      extras: { ai: { transport: {}, codec: { kind: 'message', partType: 'input_text' } } },
    } as unknown as Ably.InboundMessage;

    expect(decodedMessagePayload([msg])?.role).toBe('user');
  });
});

/**
 * Build a foreign wire — an application's own publish on a channel it shares
 * with a transport. It carries no `extras.ai` envelope.
 * @param serial - The wire serial.
 * @param overrides - Fields overriding the foreign message defaults.
 * @returns The foreign InboundMessage.
 */
const foreignMessage = (serial: string, overrides: Partial<Ably.InboundMessage> = {}): Ably.InboundMessage =>
  ({
    serial,
    action: 'message.create',
    name: 'chat.message',
    data: { text: 'hello from the app' },
    version: { serial },
    extras: { headers: { topic: 'support' } },
    ...overrides,
    // CAST: minimal InboundMessage stub — only the fields the decoder reads.
  }) as unknown as Ably.InboundMessage;

// An application may publish its own messages on a channel it shares with a
// session. They carry neither the SDK's wire names nor its `extras.ai`
// envelope; interleaving them through the decode path must leave the decoded
// event sequence identical to the clean sequence.
describe('OpenAI codec foreign messages (offline)', () => {
  it('decodes an assistant run identically with foreign messages interleaved', async () => {
    const { inbound } = await roundtrip(textRun('msg_1', 'Hello, world!'));

    // One foreign wire between every SDK wire, including an append the decoder
    // has no create for (an application streaming its own message).
    const polluted = inbound.flatMap((msg, i) => [
      foreignMessage(`foreign-${String(i)}`),
      foreignMessage(`foreign-${String(i)}-stream`, { action: 'message.append', data: 'their chunk' }),
      msg,
    ]);

    const clean = decodeOutputs(inbound);
    expect(clean.length).toBeGreaterThan(0);
    expect(decodeOutputs(polluted)).toEqual(clean);
  });

  it('decodes a foreign message to no events', () => {
    const decoder = ResponsesCodec.createDecoder();

    expect(decoder.decode(foreignMessage('foreign-1'))).toEqual({ inputs: [], outputs: [] });
  });
});

// The client-driven tool events carry no Responses stream event of their own;
// these prove the wire framing round-trips: the codec headers each descriptor
// declares (call_id / name / approved / reason) and its data envelope survive
// encode → wire → decode. The plain `item` and approved-decision round-trips
// live in inputs.test.ts.
describe('OpenAI codec client-driven tool wire roundtrip (offline)', () => {
  it('roundtrips a tool-approval-request: call_id/name on headers, arguments in data', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer, { onAblyMessage: stampHeaders('run-x', 'run-1') });
    await encoder.publishOutput(toolApprovalRequestEvent('call_1', 'getWeatherForecast', '{"location":"Paris"}'));
    await encoder.close();

    const messages = inbound();
    const wire = messages.find((m) => getCodecHeaders(m).kind === 'tool-approval-request');
    expect(wire).toBeDefined();
    expect(wire && getCodecHeaders(wire).call_id).toBe('call_1');
    expect(wire && getCodecHeaders(wire).name).toBe('getWeatherForecast');
    expect(wire?.data).toBe('{"location":"Paris"}');

    expect(decodeOutputs(messages)).toEqual([
      {
        type: 'tool-approval-request',
        call_id: 'call_1',
        name: 'getWeatherForecast',
        arguments: '{"location":"Paris"}',
      },
    ]);
  });

  it('roundtrips a denied approval decision: approved and reason ride the headers', async () => {
    const { writer, inbound } = createBridge();
    const encoder = ResponsesCodec.createEncoder(writer);
    await encoder.publishInput(
      { kind: 'approval', payload: { call_id: 'call_1', approved: false, reason: 'User denied' } },
      { messageId: 'run-1' },
    );
    await encoder.close();

    const messages = inbound();
    const wire = messages.find((m) => m.name === EVENT_AI_INPUT);
    expect(wire && getCodecHeaders(wire).approved).toBe('false');
    expect(wire && getCodecHeaders(wire).reason).toBe('User denied');

    expect(decodeInputs(messages)).toEqual([
      { kind: 'approval', payload: { call_id: 'call_1', approved: false, reason: 'User denied' } },
    ]);
  });
});

// The roundtrip tests above prove the decoder reconstructs events correctly
// when the excluded fields are absent. These prove the other half: the codec
// actually removes them, so the redundant data never reaches what a subscriber
// decodes. Most cases feed a FULL output item to output_item.done and assert the
// item on the wire is exactly the wire form WireDoneItem declares (see
// toWireItem / toWireContent in descriptors.ts); the first test covers
// the `{ item }` data-envelope framing, and another asserts sequence_number is
// dropped from every decoded event.
//
// Each test also asserts a precondition that the fed-in item genuinely carries
// the fields it then proves the wire strips. A wire-form assertion can't tell "the
// codec removed it" from "it was never there", so without the precondition a
// fixture trimmed to the minimal SDK-required shape would make the assertion
// pass vacuously.
describe('OpenAI codec wire reduction', () => {
  it("publishes each item-carrying event's item under an `{ item }` data envelope", async () => {
    const message = messageItem('msg_1', [{ type: 'output_text', text: 'Hi', annotations: [] }]);
    const added = itemAdded(message);

    // Preconditions: the added event carries the output_index/sequence_number the
    // wire strips, and the item carries the content output_item.done strips.
    expect(added).toMatchObject({ output_index: 0, sequence_number: 0 });
    expect(message.content.length).toBeGreaterThan(0);

    const { inbound } = await roundtrip([added, itemDone(message), functionCallOutputEvent('call_1', '{"ok":true}')]);
    // Two things at once, via an exact toEqual. Reduction: each event is reduced
    // to just its item on the wire — the event's own output_index /
    // sequence_number don't survive (this is the only assertion that the *added*
    // event itself is reduced; the other tests reduce output_item.done's item).
    // Framing: that item is carried under a top-level `item` key rather than as the
    // bare payload, reserving room for a sibling wire field to join the envelope.
    // output_item.added carries the full item; output_item.done the wire-form item;
    // function_call_output the codec's own item.
    expect(wireData(inbound, 'response.output_item.added')).toEqual({ item: message });
    expect(wireData(inbound, 'response.output_item.done')).toEqual({
      item: { type: 'message', id: 'msg_1', status: 'in_progress' },
    });
    expect(wireData(inbound, 'function_call_output')).toEqual({
      item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    });
  });

  it('drops sequence_number from every decoded output event', async () => {
    // sequence_number orders events within a single raw OpenAI SSE connection;
    // Ably serials already order our wire, so it is meaningful nowhere here. Every
    // fixture event below carries sequence_number, yet no decoded output should:
    // the discrete item envelopes never encode it, and the reconstructed stream
    // closes/deltas omit it (see WithoutSequenceNumber in events.ts). This spans
    // the discrete item events (output_item.added / .done) and three of the
    // codec's five streamed groups (output_text, function_call_arguments,
    // reasoning_summary_text); the other two (refusal, reasoning_text) strip it
    // by the same reconstruction path.
    const events = [
      ...textRun('msg_1', 'Hello, world!'),
      ...functionCallArgsRun('fc_1', 'call_1', 'getWeather', '{"x":1}'),
      ...reasoningSummaryRun('rs_1', 'Thinking'),
    ];

    // Precondition: every fed-in event carries the sequence_number the wire strips.
    expect(events.every((e) => 'sequence_number' in e)).toBe(true);

    const { outputs } = await roundtrip(events);
    expect(outputs.length).toBeGreaterThan(0);
    for (const event of outputs) {
      expect(event).not.toHaveProperty('sequence_number');
    }
  });

  it('output_item.done for a message reduces to id/type/status, with no content when logprobs is an empty array', async () => {
    const item = messageItem('msg_1', [{ type: 'output_text', text: 'Hi', annotations: [], logprobs: [] }]);

    // Precondition: the part carries the text/annotations the wire strips.
    expect(item.content[0]).toMatchObject({ text: 'Hi', annotations: [] });

    const { inbound } = await roundtrip([itemDone(item)]);
    // The streamed deltas already carry the text / role / annotations, so none
    // are re-sent here. An empty logprobs array is not logprobs either (the
    // length>0 guard in toWireContent), so there is no `content` at all —
    // the lean case a plain output_text with no logprobs field also yields (see
    // the decoded-shape assertion of that path in the roundtrip block above).
    expect(wireDoneItem(inbound)).toEqual({ type: 'message', id: 'msg_1', status: 'in_progress' });
  });

  it('output_item.done for a message reduces to per-part logprobs, index-aligned, dropping text/annotations/refusal string', async () => {
    const logprobs: Responses.ResponseOutputText['logprobs'] = [
      { token: 'Hi', logprob: -0.1, bytes: [72, 105], top_logprobs: [] },
    ];
    const item = messageItem('msg_1', [
      { type: 'refusal', refusal: 'no' },
      { type: 'output_text', text: 'Hi', annotations: [], logprobs },
    ]);

    // Preconditions: the parts carry the refusal string / text / annotations the wire strips.
    expect(item.content[0]).toMatchObject({ refusal: 'no' });
    expect(item.content[1]).toMatchObject({ text: 'Hi', annotations: [] });

    const { inbound } = await roundtrip([itemDone(item)]);
    // Only the logprobs residue is carried on the wire, in a placeholder array aligned
    // with the content: the refusal reduces to just its type, the output_text to
    // its type + logprobs. The text, annotations and refusal string are dropped.
    expect(wireDoneItem(inbound)).toEqual({
      type: 'message',
      id: 'msg_1',
      status: 'in_progress',
      content: [{ type: 'refusal' }, { type: 'output_text', logprobs }],
    });
  });

  it('output_item.done for a function_call reduces to id/type/status, dropping call_id/name/arguments', async () => {
    const item = functionCallItem('fc_1', 'call_1', 'getWeather', '{"location":"London"}', 'completed');

    // Precondition: the item carries the call_id/name/arguments the wire strips.
    expect(item).toMatchObject({ call_id: 'call_1', name: 'getWeather', arguments: '{"location":"London"}' });

    const { inbound } = await roundtrip([itemDone(item)]);
    // call_id / name / arguments reach the client on the stream start + deltas,
    // so output_item.done drops them and carries only the finalised status.
    expect(wireDoneItem(inbound)).toEqual({ type: 'function_call', id: 'fc_1', status: 'completed' });
  });

  it('output_item.done for a reasoning item reduces to id/type/status/encrypted_content, dropping summary', async () => {
    const reasoning: Responses.ResponseReasoningItem = {
      id: 'rs_1',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'because' }],
      encrypted_content: 'ENCRYPTED-BLOB',
    };

    // Precondition: the item carries the summary the wire strips.
    expect(reasoning.summary.length).toBeGreaterThan(0);

    const { inbound } = await roundtrip([itemDone(reasoning)]);
    // encrypted_content is the sole output_item.done-only datum that must survive
    // (the zero-data-retention (ZDR) cross-turn carrier of chain-of-thought); the
    // summary is streamed, so it reaches the client on its own stream and is
    // dropped here.
    expect(wireDoneItem(inbound)).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      status: 'completed',
      encrypted_content: 'ENCRYPTED-BLOB',
    });
  });

  it('output_item.done for a reasoning item reduces to id/type/status, omitting encrypted_content when the item has none', async () => {
    const reasoning: Responses.ResponseReasoningItem = {
      id: 'rs_1',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'because' }],
    };

    // Precondition: the item carries the summary the wire strips.
    expect(reasoning.summary.length).toBeGreaterThan(0);

    const { inbound } = await roundtrip([itemDone(reasoning)]);
    // With no encrypted_content on the item the key is omitted entirely, not
    // sent as an empty string (the string guard in toWireItem); summary is
    // streamed, so it is dropped too.
    expect(wireDoneItem(inbound)).toEqual({ type: 'reasoning', id: 'rs_1', status: 'completed' });
  });
});
