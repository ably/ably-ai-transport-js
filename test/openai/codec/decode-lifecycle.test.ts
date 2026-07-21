/**
 * OpenAI codec mid-stream-join repair (`decodeLifecycle`).
 *
 * A client that joins a run mid-flight catches a family's stream without having
 * seen the `output_item.added` that introduced the item it fills. The platform
 * delivers the in-flight streamed message as a single full-contents
 * `message.update` (first contact), so these tests encode a run through the
 * offline bridge, then re-deliver its streamed message as such an update to a
 * fresh decoder — the joiner's view — and assert the owner item is
 * reconstructed so the streamed content still folds. The present-at-start /
 * full-replay path is checked not to double the owner.
 */

import type * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import { HEADER_STREAM } from '../../../src/constants.js';
import { toCodecEvents } from '../../../src/core/codec/codec-event.js';
import type { OpenAIOutput } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import { init, type OpenAIProjection } from '../../../src/openai/codec/reducer.js';
import { getTransportHeaders } from '../../../src/utils.js';
import {
  completed,
  contentPartAdded,
  createBridge,
  created,
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
  const encoder = ResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', runId) });
  // Feed events as-is, as an agent's run.pipe does; the codec's descriptor
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

// Decode messages through a fresh decoder and fold them into a projection.
const foldMessages = (msgs: Ably.InboundMessage[]): OpenAIProjection => {
  const decoder = ResponsesCodec.createDecoder();
  let projection = init();
  for (const msg of msgs) {
    for (const event of toCodecEvents(decoder.decode(msg))) {
      projection = ResponsesCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: 'run-1' });
    }
  }
  return projection;
};

// The sole turn's output items from a folded projection.
const itemsOf = (projection: OpenAIProjection): Responses.ResponseOutputItem[] => {
  const turn = ResponsesCodec.getMessages(projection)[0]?.message;
  // CAST: an assistant turn's items are output items in these output-only tests.
  return (turn?.items ?? []) as Responses.ResponseOutputItem[];
};

// The decoded outputs a joiner sees from a single first-contact update.
const decodeJoin = (update: Ably.InboundMessage): OpenAIOutput[] =>
  ResponsesCodec.createDecoder().decode(update).outputs;

describe('OpenAI decodeLifecycle (mid-stream join)', () => {
  it('synthesises the message owner so joined output_text folds', async () => {
    const update = midStreamJoin(await encodeInbound(textRun('msg_1', 'Hello, world!')));

    // The reconstructed owner leads the join, before the family's own start.
    const outputs = decodeJoin(update);
    const added = outputs.find((e) => e.type === 'response.output_item.added');
    expect(added?.type === 'response.output_item.added' ? added.item.type : '').toBe('message');
    expect(added?.type === 'response.output_item.added' ? added.item.id : '').toBe('msg_1');
    expect(outputs.map((e) => e.type)).toContain('response.content_part.added');

    // With the owner present, the streamed text folds into it.
    const message = itemsOf(foldMessages([update])).find(
      (i): i is Responses.ResponseOutputMessage => i.type === 'message',
    );
    expect(message?.content.find((p) => p.type === 'output_text')).toEqual({
      type: 'output_text',
      text: 'Hello, world!',
      annotations: [],
    });
  });

  it('synthesises a reasoning owner so a joined reasoning summary folds', async () => {
    const update = midStreamJoin(
      await encodeInbound([created(), ...reasoningSummaryRun('rs_1', 'Thinking…'), completed()]),
    );

    const added = decodeJoin(update).find((e) => e.type === 'response.output_item.added');
    expect(added?.type === 'response.output_item.added' ? added.item.type : '').toBe('reasoning');

    const item = itemsOf(foldMessages([update])).find(
      (i): i is Responses.ResponseReasoningItem => i.type === 'reasoning',
    );
    expect(item?.summary).toEqual([{ type: 'summary_text', text: 'Thinking…' }]);
  });

  it('synthesises a reasoning owner so joined reasoning text folds', async () => {
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

    const added = decodeJoin(update).find((e) => e.type === 'response.output_item.added');
    expect(added?.type === 'response.output_item.added' ? added.item.type : '').toBe('reasoning');

    const item = itemsOf(foldMessages([update])).find(
      (i): i is Responses.ResponseReasoningItem => i.type === 'reasoning',
    );
    expect(item?.content).toEqual([{ type: 'reasoning_text', text: 'because' }]);
  });

  it('needs no synthetic owner for a joined function-call stream (its start is the item)', async () => {
    const update = midStreamJoin(
      await encodeInbound([
        created(),
        ...functionCallArgsRun('fc_1', 'call_1', 'getWeather', '{"location":"London"}'),
        completed(),
      ]),
    );

    // The function-call family's start reconstructs the item itself, so the
    // join carries exactly one output_item.added (not a spurious extra).
    const added = decodeJoin(update).filter((e) => e.type === 'response.output_item.added');
    expect(added).toHaveLength(1);
    expect(added[0]?.type === 'response.output_item.added' ? added[0].item.type : '').toBe('function_call');

    const item = itemsOf(foldMessages([update])).find(
      (i): i is Responses.ResponseFunctionToolCall => i.type === 'function_call',
    );
    expect(item?.arguments).toBe('{"location":"London"}');
    expect(item?.name).toBe('getWeather');
  });

  it('folds sibling streams that share an item on join into one message', async () => {
    // One message with output_text at content[0] and a refusal at content[1] —
    // two streams, one owner. Each stream's join synthesises its own owner add
    // (the policy holds no state), so two adds reach the reducer; its
    // find-or-create by item id collapses them to the single message.
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
    let projection = init();
    let ownerAdds = 0;
    for (const create of streamCreates) {
      const update = asFirstContactUpdate(create, msgs);
      const decoded = decoder.decode(update);
      ownerAdds += decoded.outputs.filter((e) => e.type === 'response.output_item.added').length;
      for (const event of toCodecEvents(decoded)) {
        projection = ResponsesCodec.fold(projection, event, { serial: update.serial ?? '', messageId: 'run-1' });
      }
    }

    // Each sibling stream synthesises an owner add; the reducer dedups them.
    expect(ownerAdds).toBe(2);
    const messages = itemsOf(projection).filter((i) => i.type === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type === 'message' ? messages[0].content : []).toEqual([
      { type: 'output_text', text: 'hi', annotations: [] },
      { type: 'refusal', refusal: 'no' },
    ]);
  });

  it('does not double the owner for a client present at the genuine start', async () => {
    // A full replay decodes the real output_item.added and, on the stream start,
    // a synthetic one for the same id. The reducer's find-or-create collapses
    // the pair: exactly one message item survives.
    const messages = itemsOf(foldMessages(await encodeInbound(textRun('msg_1', 'Hello, world!')))).filter(
      (i) => i.type === 'message',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type === 'message' ? messages[0].content : []).toEqual([
      { type: 'output_text', text: 'Hello, world!', annotations: [] },
    ]);
  });
});
