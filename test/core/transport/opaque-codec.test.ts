/**
 * Opaque-codec transport tests — the unconstrained-generics contract.
 *
 * `WireCodec<TInput, TOutput>` and both transports carry codec events
 * opaquely: nothing generic reads event content, and the type parameters are
 * unconstrained. These tests pin that contract by driving the transports with
 * a hand-written codec whose event types have NO `kind` or `type` field — the
 * discriminants `defineCodec`'s authoring tables dispatch on. A regression
 * that makes the generic layer inspect an event (or constrain the parameters)
 * fails to compile here.
 */

import * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import type { ChannelWriter, Decoder, Encoder, WireCodec, WriteOptions } from '../../../src/core/codec/types.js';
import { createAgentTransport } from '../../../src/core/transport/agent-transport.js';
import { createClientTransport } from '../../../src/core/transport/client-transport.js';
import type { TransportEvent } from '../../../src/core/transport/types.js';
import { createMockChannel } from '../../helper/mock-channel.js';
import { streamOf } from '../../helper/streams.js';

/** An input with no `kind` discriminant. */
interface OpaqueInput {
  text: string;
}
/** An output with no `type` discriminant. */
interface OpaqueOutput {
  delta: string;
}

type OpaqueEvent = TransportEvent<OpaqueInput, OpaqueOutput>;

/**
 * A hand-written wire codec over the opaque types: inputs and outputs ride as
 * JSON under the SDK's message names, honouring the write options' extras so
 * the transport's headers reach the wire.
 * @returns The codec.
 */
const createOpaqueCodec = (): WireCodec<OpaqueInput, OpaqueOutput> => ({
  createEncoder: (channel: ChannelWriter): Encoder<OpaqueInput, OpaqueOutput> => ({
    publishInput: async (input: OpaqueInput, options?: WriteOptions): Promise<Ably.PublishResult> =>
      channel.publish({ name: 'ai-input', data: JSON.stringify(input), extras: options?.extras }),
    publishOutput: async (output: OpaqueOutput, options?: WriteOptions): Promise<void> => {
      await channel.publish({ name: 'ai-output', data: JSON.stringify(output), extras: options?.extras });
    },
    cancelStreams: async (): Promise<void> => {
      /* no streams */
    },
    close: async (): Promise<void> => {
      /* nothing held */
    },
  }),
  createDecoder: (): Decoder<OpaqueInput, OpaqueOutput> => ({
    decode: (msg: Ably.InboundMessage): { inputs: OpaqueInput[]; outputs: OpaqueOutput[] } => {
      // CAST: trust boundary — this codec's own wire data is its JSON form.
      if (msg.name === 'ai-input') return { inputs: [JSON.parse(String(msg.data)) as OpaqueInput], outputs: [] };
      if (msg.name === 'ai-output') return { inputs: [], outputs: [JSON.parse(String(msg.data)) as OpaqueOutput] };
      return { inputs: [], outputs: [] };
    },
  }),
});

describe('transports over a discriminant-free codec', () => {
  it('client transport publishes and classifies opaque events untouched', async () => {
    const channel = createMockChannel();
    const transport = createClientTransport({ channel, codec: createOpaqueCodec() });
    const events: OpaqueEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();

    const sent = await transport.publishInput({ text: 'hello' });
    expect(sent.transportMessageId).toBeTruthy();
    // The published wire carries the input object as its JSON form, untouched.
    const published = channel.publishCalls.find((m) => m.name === 'ai-input');
    // CAST: this codec's own wire data is its JSON form.
    expect(JSON.parse(String(published?.data)) as OpaqueInput).toEqual({ text: 'hello' });

    // A live output wire classifies to the opaque output as-is.
    channel.listener?.({
      name: 'ai-output',
      action: 'message.create',
      serial: 's-1',
      data: JSON.stringify({ delta: 'world' }),
      extras: { ai: { transport: { 'run-id': 'run-1' } } },
      version: { serial: 's-1' },
      // CAST: minimal InboundMessage stub — only the fields the merge reads.
    } as unknown as Ably.InboundMessage);
    const live = events.find((e) => e.kind === 'message' && e.outputs.length > 0);
    expect(live?.kind === 'message' && live.outputs[0]).toEqual({ delta: 'world' });
  });

  it('agent transport opens a run and pipes opaque outputs untouched', async () => {
    const channel = createMockChannel();
    const transport = createAgentTransport({ channel, codec: createOpaqueCodec() });
    await transport.connect();

    const run = transport.openRun({ runId: 'run-1' });
    const result = await run.pipe(streamOf<OpaqueOutput>({ delta: 'a' }, { delta: 'b' }));
    await run.end({ reason: 'complete' });

    expect(result.reason).toBe('complete');
    const outputs = channel.publishCalls.filter((m) => m.name === 'ai-output');
    // CAST: this codec's own wire data is its JSON form.
    expect(outputs.map((m) => (JSON.parse(String(m.data)) as OpaqueOutput).delta)).toEqual(['a', 'b']);
  });
});
