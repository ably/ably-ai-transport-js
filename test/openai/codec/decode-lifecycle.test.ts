/**
 * OpenAI codec mid-stream-join repair (`decoderSynthesiseLifecycle`).
 *
 * A client that joins a run mid-flight catches a group's stream without having
 * seen the `output_item.added` that introduced the item it fills. The platform
 * delivers the in-flight streamed message as a single full-contents
 * `message.update` (first contact), so these tests encode a run through the
 * offline bridge, then re-deliver its streamed message as such an update to a
 * fresh decoder — the joiner's view — and assert the decoded event sequence
 * leads with the synthesised `output_item.added` opening bracket (correct item
 * type, id recovered from the codec headers) ahead of the group's own start and
 * the accumulated deltas. Synthesis is stateless and unconditional, so a full
 * replay re-introduces the item id alongside the genuine opening bracket; a
 * consumer folding the events collapses the pair by item id.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { HEADER_STREAM } from '../../../src/constants.js';
import type { OpenAIOutput } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import { getTransportHeaders } from '../../../src/utils.js';
import {
  completed,
  contentPartAdded,
  createBridge,
  created,
  eventsOfType,
  functionCallArgsRun,
  itemAdded,
  messageItem,
  reasoningItem,
  reasoningSummaryRun,
  reasoningTextDelta,
  reasoningTextDone,
  reasoningTextPartAdded,
  refusalDelta,
  refusalDone,
  refusalPartAdded,
  stampHeaders,
  textDelta,
  textDone,
  textRun,
} from './fixtures.js';

const transportOf = (m: Ably.InboundMessage): Record<string, string> => getTransportHeaders(m);

// Encode a run through the offline bridge and return the inbound wire messages.
const encodeInbound = async (events: OpenAIOutput[], runId = 'run-1'): Promise<Ably.InboundMessage[]> => {
  const { writer, inbound } = createBridge();
  const encoder = ResponsesCodec.createEncoder(writer, { onAblyMessage: stampHeaders('run-x', runId) });
  // Feed events as-is, as an agent's pipe does; the codec's descriptor
  // table drops the framing events at encode.
  for (const event of events) await encoder.publishOutput(event);
  await encoder.close();
  return inbound();
};

// Re-express a run's streamed `message.create` as the full-contents
// `message.update` a joiner gets on first contact (headers intact, still at
// `streaming` status), carrying the text accumulated so far.
const asFirstContactUpdate = (create: Ably.InboundMessage, msgs: Ably.InboundMessage[]): Ably.InboundMessage => {
  const accumulated = msgs
    .filter((m) => m.action === 'message.append' && m.serial === create.serial)
    .map((m) => (typeof m.data === 'string' ? m.data : ''))
    .join('');
  // Reshape the recorded create into a first-contact update; the decoder reads
  // action / serial / version / name / data / extras, all preserved by the spread.
  return { ...create, action: 'message.update', data: accumulated };
};

// The joiner's single first-contact update for a run with one streamed message.
const midStreamJoin = (msgs: Ably.InboundMessage[]): Ably.InboundMessage => {
  const create = msgs.find((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true');
  if (!create) throw new Error('no streamed message in the encoded run');
  return asFirstContactUpdate(create, msgs);
};

// The decoded outputs a joiner sees from a single first-contact update.
const decodeJoin = (update: Ably.InboundMessage): OpenAIOutput[] =>
  ResponsesCodec.createDecoder().decode(update).outputs;

// Decode a whole inbound sequence's outputs through a fresh decoder.
const decodeAll = (msgs: Ably.InboundMessage[]): OpenAIOutput[] => {
  const decoder = ResponsesCodec.createDecoder();
  return msgs.flatMap((msg) => decoder.decode(msg).outputs);
};

describe('OpenAI decoderSynthesiseLifecycle (mid-stream join)', () => {
  it('synthesises the message opening bracket ahead of joined output_text', async () => {
    const update = midStreamJoin(await encodeInbound(textRun('msg_1', 'Hello, world!')));

    const outputs = decodeJoin(update);
    const types = outputs.map((e) => e.type);

    // The synthesised opening bracket leads the join — item type and id
    // recovered from the re-stamped codec headers — before the group's own
    // start, which precedes the accumulated text.
    const added = eventsOfType(outputs, 'response.output_item.added')[0];
    expect(added?.item).toMatchObject({ type: 'message', id: 'msg_1' });
    const partAdded = eventsOfType(outputs, 'response.content_part.added')[0];
    expect(partAdded).toMatchObject({ item_id: 'msg_1', content_index: 0 });
    expect(types.indexOf('response.output_item.added')).toBeLessThan(types.indexOf('response.content_part.added'));
    expect(types.indexOf('response.content_part.added')).toBeLessThan(types.indexOf('response.output_text.delta'));

    // The joiner receives the text accumulated so far.
    const deltas = eventsOfType(outputs, 'response.output_text.delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('Hello, world!');
  });

  it('synthesises a reasoning opening bracket ahead of a joined reasoning summary', async () => {
    const update = midStreamJoin(
      await encodeInbound([created(), ...reasoningSummaryRun('rs_1', 'Thinking…'), completed()]),
    );

    const outputs = decodeJoin(update);
    const added = eventsOfType(outputs, 'response.output_item.added')[0];
    expect(added?.item).toMatchObject({ type: 'reasoning', id: 'rs_1' });

    const types = outputs.map((e) => e.type);
    expect(types.indexOf('response.output_item.added')).toBeLessThan(
      types.indexOf('response.reasoning_summary_part.added'),
    );
    const deltas = eventsOfType(outputs, 'response.reasoning_summary_text.delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('Thinking…');
  });

  it('synthesises a reasoning opening bracket ahead of joined reasoning text', async () => {
    const update = midStreamJoin(
      await encodeInbound([
        created(),
        itemAdded(reasoningItem('rs_1')),
        reasoningTextPartAdded('rs_1', 0),
        reasoningTextDelta('rs_1', 'be', 0),
        reasoningTextDelta('rs_1', 'cause', 0),
        reasoningTextDone('rs_1', 'because', 0),
        completed(),
      ]),
    );

    const outputs = decodeJoin(update);
    const added = eventsOfType(outputs, 'response.output_item.added')[0];
    expect(added?.item).toMatchObject({ type: 'reasoning', id: 'rs_1' });

    const types = outputs.map((e) => e.type);
    expect(types.indexOf('response.output_item.added')).toBeLessThan(types.indexOf('response.content_part.added'));
    const deltas = eventsOfType(outputs, 'response.reasoning_text.delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('because');
  });

  it('needs no synthetic opening bracket for a joined function-call stream (its start is the item)', async () => {
    const update = midStreamJoin(
      await encodeInbound([
        created(),
        ...functionCallArgsRun('fc_1', 'call_1', 'getWeather', '{"location":"London"}'),
        completed(),
      ]),
    );

    // The function-call group's start reconstructs the item itself, so the
    // join carries exactly one output_item.added (not a spurious extra).
    const outputs = decodeJoin(update);
    const added = eventsOfType(outputs, 'response.output_item.added');
    expect(added).toHaveLength(1);
    expect(added[0]?.item).toMatchObject({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'getWeather' });

    // The arguments accumulated so far arrive on the group's own delta.
    const deltas = eventsOfType(outputs, 'response.function_call_arguments.delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('{"location":"London"}');
  });

  it('synthesises one opening bracket per joined sibling stream, sharing the item id', async () => {
    // One message with output_text at content[0] and a refusal at content[1] —
    // two streams, one item. Each stream's join synthesises its own
    // opening-bracket add (the policy holds no state), so both adds reach the
    // consumer carrying the same item id, ready to collapse by id.
    const msgs = await encodeInbound([
      created(),
      itemAdded(messageItem('msg_1')),
      contentPartAdded('msg_1', 0),
      refusalPartAdded('msg_1', 1),
      textDelta('msg_1', 'hi', 0),
      refusalDelta('msg_1', 'no', 1),
      textDone('msg_1', 'hi', 0),
      refusalDone('msg_1', 'no', 1),
      completed(),
    ]);

    // The joiner sees both in-flight streams as first-contact updates.
    const streamCreates = msgs.filter((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true');
    expect(streamCreates).toHaveLength(2);
    const decoder = ResponsesCodec.createDecoder();
    const outputs = streamCreates.flatMap((create) => decoder.decode(asFirstContactUpdate(create, msgs)).outputs);

    const adds = eventsOfType(outputs, 'response.output_item.added');
    expect(adds).toHaveLength(2);
    expect(adds.map((a) => a.item.id)).toEqual(['msg_1', 'msg_1']);
    expect(adds.every((a) => a.item.type === 'message')).toBe(true);

    // Each stream's accumulated delta is addressed to its own content slot.
    expect(eventsOfType(outputs, 'response.output_text.delta')).toEqual([
      expect.objectContaining({ item_id: 'msg_1', content_index: 0, delta: 'hi' }),
    ]);
    expect(eventsOfType(outputs, 'response.refusal.delta')).toEqual([
      expect.objectContaining({ item_id: 'msg_1', content_index: 1, delta: 'no' }),
    ]);
  });

  it('re-introduces the same item id on a full replay (synthesis is unconditional)', async () => {
    // A full replay decodes the real output_item.added and, on the stream
    // start, a synthesised one for the same id — the policy holds no state, so
    // it cannot tell a join from a replay. Both adds carry the same item id,
    // which is what lets a consumer collapse them into one item.
    const outputs = decodeAll(await encodeInbound(textRun('msg_1', 'Hello, world!')));

    const adds = eventsOfType(outputs, 'response.output_item.added');
    expect(adds).toHaveLength(2);
    expect(adds.every((a) => a.item.type === 'message' && a.item.id === 'msg_1')).toBe(true);

    // The streamed text still decodes once, closed by the accumulated done.
    expect(eventsOfType(outputs, 'response.output_text.done')[0]?.text).toBe('Hello, world!');
  });
});
