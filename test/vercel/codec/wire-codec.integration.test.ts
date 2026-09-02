/**
 * Vercel wire-codec integration test — the provider-reducer round-trip.
 *
 * Publishes an output chunk stream and a tool-output action body through a
 * real Ably channel, reads both back with the wire codec's decoder, and
 * reconstructs the assistant message by feeding the chunks — outputs and the
 * chunk-shaped input body alike — through the provider's own reducer
 * (`readUIMessageStream` from `ai`). The SDK folds nothing: the only
 * application work is bucketing the interleaved wire by codec-message-id,
 * which is the demultiplexing a provider reducer cannot do itself.
 */

import type * as Ably from 'ably';
import * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../../src/constants.js';
import { getTransportHeaders } from '../../../src/utils.js';
import { createUIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { foldWithProviderReducer } from '../../helper/ui-message-fold.js';

const codec = createUIMessageCodec();

/**
 * Stamp run and codec-message-id transport headers on every outgoing message,
 * as the transport layer would.
 * @param runId - The run ID to stamp.
 * @param messageId - The codec-message-id to stamp.
 * @returns An onAblyMessage callback for encoder options.
 */
const stampHeaders = (runId: string, messageId: string) => (msg: Ably.Message) => {
  // CAST: Ably SDK types `extras` as `any`; the encoder always sets the envelope.
  const transport = (msg.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
  if (transport) {
    transport[HEADER_RUN_ID] = runId;
    transport[HEADER_CODEC_MESSAGE_ID] = messageId;
  }
};

describe('Vercel wire-codec provider-reducer roundtrip', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('reconstructs an assistant message from output chunks plus a tool-output body, with the SDK folding nothing', async () => {
    const channelName = uniqueChannelName('wire-provider-roundtrip');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = codec.createDecoder();
    const messageId = 'asst-1';

    // The application's demultiplexing: bucket chunks by codec-message-id, in
    // wire order. Inputs whose bodies are provider chunks land in the same
    // bucket as the outputs, so one fold covers both directions.
    const buckets = new Map<string, AI.UIMessageChunk[]>();
    let resolveToolOutput: () => void;
    const toolOutputSeen = new Promise<void>((r) => {
      resolveToolOutput = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      const id = getTransportHeaders(msg)[HEADER_CODEC_MESSAGE_ID];
      if (id === undefined) return;
      const bucket = buckets.get(id) ?? [];
      buckets.set(id, bucket);
      bucket.push(...decoded.outputs);
      for (const input of decoded.inputs) {
        if (input.kind === 'chunk') {
          bucket.push(input.payload);
          resolveToolOutput();
        }
      }
    });

    // The agent's half: a streamed assistant turn ending in a tool call.
    const encoder = codec.createEncoder(pubChannel, { onAblyMessage: stampHeaders('run-1', messageId) });
    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    await encoder.publishOutput({ type: 'text-start', id: 'text-1' });
    void encoder.publishOutput({ type: 'text-delta', id: 'text-1', delta: 'Checking the weather' });
    await encoder.publishOutput({ type: 'text-end', id: 'text-1' });
    await encoder.publishOutput({
      type: 'tool-input-available',
      toolCallId: 'tc-1',
      toolName: 'getWeather',
      input: { city: 'Berlin' },
      dynamic: true,
    });
    await encoder.close();

    // The client's half: the tool resolution, published as the provider's own
    // chunk against the assistant's codec-message-id.
    const clientEncoder = codec.createEncoder(pubChannel);
    await clientEncoder.publishInput(
      {
        kind: 'chunk',
        payload: { type: 'tool-output-available', toolCallId: 'tc-1', output: { tempC: 21 }, dynamic: true },
      },
      { messageId },
    );
    await clientEncoder.close();

    await toolOutputSeen;

    // The provider's reducer folds the bucket — the SDK contributed decode only.
    const bucket = buckets.get(messageId);
    expect(bucket).toBeDefined();
    const message = await foldWithProviderReducer(bucket ?? []);

    expect(message).toBeDefined();
    const textPart = message?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('Checking the weather');
    const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
    expect(toolPart?.state).toBe('output-available');
    if (toolPart?.state === 'output-available') {
      expect(toolPart.output).toEqual({ tempC: 21 });
    }
  }, 30000);
});
