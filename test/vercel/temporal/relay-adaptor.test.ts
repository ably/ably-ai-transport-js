import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { type VercelEvent, vercelTemporalRelayAdaptor } from '../../../src/vercel/index.js';
import { createMockChannel } from '../../helper/mock-channel.js';

// eslint-disable-next-line unicorn/no-null -- the relay passes null when a route starts
const ROUTE_START = null;

const encoder = new TextEncoder();

/**
 * A model stream part as Temporal's AI SDK plugin publishes it to the Workflow Stream.
 * @param part - The part.
 * @param offset - Its offset in the Workflow Stream.
 * @returns The relay event.
 */
const modelPart = (part: unknown, offset: number): { topic: string; offset: number; data: Uint8Array } => ({
  topic: 'model',
  offset,
  data: encoder.encode(JSON.stringify(part)),
});

/**
 * A chunk the workflow published itself, as an object.
 * @param data - The chunk.
 * @param offset - Its offset in the Workflow Stream.
 * @returns The relay event.
 */
const turnChunk = (data: VercelEvent, offset: number): { topic: string; offset: number; data: VercelEvent } => ({
  topic: 'turn',
  offset,
  data,
});

/**
 * The `extras.ai.type` the codec wrote on a recorded message.
 * @param message - The message.
 * @param message.extras - Its extras.
 * @returns The type.
 */
const typeOf = (message: { extras?: unknown }): unknown =>
  // CAST: Ably types `extras` as `any`; the test reads one key off it.
  (message.extras as { ai?: { type?: unknown } } | undefined)?.ai?.type;

describe('vercelTemporalRelayAdaptor', () => {
  it("writes the workflow's chunks as they are and the model's parts as the chunks they map to", async () => {
    const channel = createMockChannel();
    const adaptor = vercelTemporalRelayAdaptor()(channel, ROUTE_START);

    adaptor.write(turnChunk({ type: 'start', messageId: 'msg_1' }, 0));
    adaptor.write(modelPart({ type: 'stream-start', warnings: [] }, 1));
    adaptor.write(modelPart({ type: 'text-start', id: 't' }, 2));
    adaptor.write(modelPart({ type: 'text-delta', id: 't', delta: 'Hel' }, 3));
    adaptor.write(modelPart({ type: 'text-delta', id: 't', delta: 'lo' }, 4));
    adaptor.write(modelPart({ type: 'text-end', id: 't' }, 5));
    adaptor.write(turnChunk({ type: 'finish', finishReason: 'stop' }, 6));
    await adaptor.close();

    expect(channel.publishCalls.map((m) => typeOf(m))).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(channel.appendCalls.map((m): unknown => m.data)).toEqual(['lo']);
  });

  it('writes nothing for a model part that has no chunk', async () => {
    const channel = createMockChannel();
    const adaptor = vercelTemporalRelayAdaptor()(channel, ROUTE_START);

    adaptor.write(modelPart({ type: 'response-metadata', id: 'r1', modelId: 'm' }, 0));
    await adaptor.flush();

    expect(channel.publishCalls).toHaveLength(0);
  });

  it('throws a 400 InvalidArgument the relay does not skip for bytes that are not a model stream part', () => {
    const adaptor = vercelTemporalRelayAdaptor()(createMockChannel(), ROUTE_START);
    const write = () => {
      adaptor.write({ topic: 'model', offset: 0, data: encoder.encode('not json') });
    };

    expect(write).toThrowErrorInfo({ code: ErrorCode.InvalidArgument, statusCode: 400 });
    expect(write).toThrow(expect.not.objectContaining({ type: 'AblyRelayUnsupportedEvent' }));
  });

  it.each([
    [
      'a chunk the codec has no row for',
      // CAST: a chunk type from an AI SDK release newer than the codec, which the union does not list.
      turnChunk({ type: 'a-chunk-from-a-later-release' } as unknown as VercelEvent, 0),
    ],
    ['a model part with no mapping', modelPart({ type: 'file', mediaType: 'image/png', data: 'AAAA' }, 0)],
  ])('marks %s as an event the relay skips, and carries on', async (_, event) => {
    const channel = createMockChannel();
    const adaptor = vercelTemporalRelayAdaptor()(channel, ROUTE_START);

    expect(() => {
      adaptor.write(event);
    }).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400, type: 'AblyRelayUnsupportedEvent' }),
    );
    adaptor.write(turnChunk({ type: 'start', messageId: 'msg_1' }, 1));
    await adaptor.flush();

    expect(channel.publishCalls.map((m) => typeOf(m))).toEqual(['start']);
  });
});
