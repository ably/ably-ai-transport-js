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

import { HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../../src/constants.js';
import { toCodecEvents } from '../../../src/core/codec/codec-event.js';
import type { OpenAIOutput } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import { init, type OpenAIProjection } from '../../../src/openai/codec/reducer.js';
import { getTransportHeaders } from '../../../src/utils.js';
import {
  completed,
  contentPartDone,
  createBridge,
  created,
  failed,
  incomplete,
  inProgress,
  itemAdded,
  itemDone,
  messageItem,
  queued,
  stampHeaders,
  streamError,
  textRun,
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
    expect(streamCreate && transportOf(streamCreate)[HEADER_STREAM_ID]).toBe('msg_1');

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

  it('roundtrips each discrete lifecycle/structural event through encode + decode', async () => {
    const item = messageItem('msg_1', [{ type: 'output_text', text: 'done', annotations: [] }]);
    const { outputs } = await roundtrip([
      created(),
      inProgress(),
      queued(),
      itemAdded(item),
      itemDone(item),
      contentPartDone('msg_1'),
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
});
