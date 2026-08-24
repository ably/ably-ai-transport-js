/**
 * OpenAI wire-codec integration tests — encode → real Ably channel → decode.
 *
 * The offline codec suite proves the event mapping against hand-built wire
 * shapes; these tests prove the same mapping over real Ably serialization,
 * where streamed groups ride genuine `message.append` deliveries. A
 * subscriber decodes every inbound message on the wire codec's decoder and
 * buckets by codec-message-id — the application's demultiplexing — and the
 * assertions check the decoded event sequences a consumer would merge.
 */

import { describe, expect, it } from 'vitest';

import { HEADER_CODEC_MESSAGE_ID } from '../../../src/constants.js';
import type { OpenAIOutput } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import { getTransportHeaders } from '../../../src/utils.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { eventsOfType, functionCallArgsRun, stampHeaders, textRun } from './fixtures.js';

/** One decoded bucket: the outputs and inputs decoded under a codec-message-id. */
interface Bucket {
  /** The decoded output events, in delivery order. */
  outputs: OpenAIOutput[];
  /** The decoded input events, in delivery order. */
  inputs: unknown[];
}

/**
 * Subscribe a decoding collector to a fresh channel pair: every inbound
 * message decodes on one decoder and lands in its codec-message-id bucket.
 * @param channelName - The test's unique channel name.
 * @returns The publisher channel, the buckets, and a waiter for a predicate.
 */
const setupCollector = async (
  channelName: string,
): Promise<{
  pubChannel: ReturnType<ReturnType<typeof ablyRealtimeClient>['channels']['get']>;
  buckets: Map<string, Bucket>;
  waitFor: (predicate: () => boolean) => Promise<void>;
}> => {
  const pubClient = ablyRealtimeClient();
  const subClient = ablyRealtimeClient();
  const pubChannel = pubClient.channels.get(channelName);
  const subChannel = subClient.channels.get(channelName);

  const decoder = ResponsesCodec.createDecoder();
  const buckets = new Map<string, Bucket>();
  const waiters = new Set<{ predicate: () => boolean; resolve: () => void }>();

  await subChannel.subscribe((msg) => {
    const decoded = decoder.decode(msg);
    const id = getTransportHeaders(msg)[HEADER_CODEC_MESSAGE_ID];
    if (id === undefined) return;
    const bucket = buckets.get(id) ?? { outputs: [], inputs: [] };
    buckets.set(id, bucket);
    bucket.outputs.push(...decoded.outputs);
    bucket.inputs.push(...decoded.inputs);
    for (const waiter of waiters) {
      if (waiter.predicate()) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  });

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      waiters.add({ predicate, resolve });
    });
  };

  return { pubChannel, buckets, waitFor };
};

describe('OpenAI wire-codec integration', () => {
  it('roundtrips a streamed text turn over real appends', async () => {
    const { pubChannel, buckets, waitFor } = await setupCollector(uniqueChannelName('openai-codec-text'));
    try {
      const encoder = ResponsesCodec.createEncoder(pubChannel, {
        onAblyMessage: stampHeaders('run-1', 'asst-1'),
      });
      for (const event of textRun('msg_1', 'Hello, world!')) {
        await encoder.publishOutput(event);
      }
      await encoder.close();

      await waitFor(() => eventsOfType(buckets.get('asst-1')?.outputs ?? [], 'response.output_item.done').length === 1);

      const outputs = buckets.get('asst-1')?.outputs ?? [];
      const types = outputs.map((e) => e.type);
      // The consumer-facing bracket holds across real serialization: item
      // envelope, content-part opener, streamed deltas, then the closes.
      expect(types.indexOf('response.output_item.added')).toBeLessThan(types.indexOf('response.content_part.added'));
      expect(types.indexOf('response.content_part.added')).toBeLessThan(types.indexOf('response.output_text.delta'));
      expect(types.indexOf('response.output_text.delta')).toBeLessThan(types.indexOf('response.output_text.done'));
      expect(types.indexOf('response.output_text.done')).toBeLessThan(types.indexOf('response.output_item.done'));

      const deltas = eventsOfType(outputs, 'response.output_text.delta');
      expect(deltas.map((d) => d.delta).join('')).toBe('Hello, world!');
      const done = eventsOfType(outputs, 'response.output_text.done')[0];
      expect(done).toMatchObject({ item_id: 'msg_1', text: 'Hello, world!' });
    } finally {
      closeAllClients();
    }
  }, 30000);

  it('roundtrips a streamed function call and its server-executed output', async () => {
    const { pubChannel, buckets, waitFor } = await setupCollector(uniqueChannelName('openai-codec-tool'));
    try {
      const args = '{"city":"Berlin"}';
      const encoder = ResponsesCodec.createEncoder(pubChannel, {
        onAblyMessage: stampHeaders('run-1', 'asst-1'),
      });
      for (const event of functionCallArgsRun('fc_1', 'call-1', 'getWeather', args)) {
        await encoder.publishOutput(event);
      }
      // The codec's own output event carrying the server-executed result.
      await encoder.publishOutput({
        type: 'function_call_output',
        item: { type: 'function_call_output', call_id: 'call-1', output: '{"tempC":21}' },
      });
      await encoder.close();

      await waitFor(() => eventsOfType(buckets.get('asst-1')?.outputs ?? [], 'function_call_output').length === 1);

      const outputs = buckets.get('asst-1')?.outputs ?? [];
      // The item envelope (call_id / name) rides the reconstructed
      // output_item.added; the arguments ride the deltas and their
      // reconstructed done.
      const added = eventsOfType(outputs, 'response.output_item.added')[0];
      expect(added?.item).toMatchObject({ type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'getWeather' });
      const argsDeltas = eventsOfType(outputs, 'response.function_call_arguments.delta');
      expect(argsDeltas.map((d) => d.delta).join('')).toBe(args);
      const argsDone = eventsOfType(outputs, 'response.function_call_arguments.done')[0];
      expect(argsDone).toMatchObject({ item_id: 'fc_1', arguments: args });
      const resolution = eventsOfType(outputs, 'function_call_output')[0];
      expect(resolution?.item).toEqual({ type: 'function_call_output', call_id: 'call-1', output: '{"tempC":21}' });
    } finally {
      closeAllClients();
    }
  }, 30000);

  it('passes application-defined input bodies through the wire verbatim', async () => {
    const { pubChannel, buckets, waitFor } = await setupCollector(uniqueChannelName('openai-codec-inputs'));
    try {
      const encoder = ResponsesCodec.createEncoder(pubChannel, {
        onAblyMessage: stampHeaders('run-1', 'user-1'),
      });
      // Inputs are passthrough JSON: these bodies are the application's own
      // vocabulary, not codec types.
      const turn = {
        kind: 'message',
        payload: {
          role: 'user',
          items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is the weather?' }] }],
        },
      };
      const resolution = {
        kind: 'item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' },
      };
      const decision = { kind: 'approval', payload: { call_id: 'call-2', approved: false, reason: 'not now' } };
      await encoder.publishInput(turn);
      await encoder.publishInput(resolution, { messageId: 'user-1' });
      await encoder.publishInput(decision, { messageId: 'user-1' });
      await encoder.close();

      await waitFor(() => (buckets.get('user-1')?.inputs.length ?? 0) === 3);

      const inputs = buckets.get('user-1')?.inputs ?? [];
      expect(inputs[0]).toEqual(turn);
      expect(inputs[1]).toEqual(resolution);
      expect(inputs[2]).toEqual(decision);
    } finally {
      closeAllClients();
    }
  }, 30000);
});
