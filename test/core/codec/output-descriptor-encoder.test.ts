import { describe, expect, it, vi } from 'vitest';

import type { EncoderCore } from '../../../src/core/codec/encoder.js';
import { jsonField, strField } from '../../../src/core/codec/fields.js';
import type { OutputEncodeContext } from '../../../src/core/codec/output-descriptor-encoder.js';
import { createOutputDescriptorEncoder } from '../../../src/core/codec/output-descriptor-encoder.js';
import { outputBuilder } from '../../../src/core/codec/output-descriptors.js';

// A family whose slot identity is composite (item_id + content_index): no single
// top-level string key names the stream, so the descriptor derives the id.
type U =
  | { type: 'x-start'; item_id: string; content_index: number }
  | { type: 'x-delta'; item_id: string; content_index: number; delta: string }
  | { type: 'x-end'; item_id: string; content_index: number; text: string }
  // A family whose start carries the id nested inside an envelope (relocated):
  // the extractor reads a different place per phase.
  | { type: 'y-start'; item: { id: string } }
  | { type: 'y-delta'; item_id: string; delta: string }
  | { type: 'y-end'; item_id: string; text: string };

const fItemId = strField('item_id');
const fContentIndex = jsonField<number, 'content_index'>('content_index');

// Standalone mock fns handed back beside the core so assertions never touch a
// bound method on the core object.
const mockCore = () => {
  const startStream = vi.fn(async () => {
    await Promise.resolve();
  });
  const appendStream = vi.fn();
  const closeStream = vi.fn(async () => {
    await Promise.resolve();
  });
  const core: EncoderCore = {
    publishDiscrete: vi.fn(async () => await Promise.resolve({ serials: [] })),
    publishDiscreteBatch: vi.fn(async () => await Promise.resolve({ serials: [] })),
    startStream,
    appendStream,
    closeStream,
    cancelAllStreams: vi.fn(async () => {
      await Promise.resolve();
    }),
    close: vi.fn(async () => {
      await Promise.resolve();
    }),
  };
  return { core, startStream, appendStream, closeStream };
};

const ctx: OutputEncodeContext = { messageId: 'cm-1', opts: undefined };

const { stream } = outputBuilder<U>();

describe('output descriptor encoder — derived stream id', () => {
  it('derives a composite id via the extractor on every phase', async () => {
    const encoder = createOutputDescriptorEncoder<U>(
      [
        stream('x', {
          start: 'x-start',
          delta: 'x-delta',
          end: 'x-end',
          streamId: (chunk) => `${chunk.item_id}:${String(chunk.content_index)}`,
          deltaField: 'delta',
          fields: [fItemId, fContentIndex],
        }),
      ],
      'ai-output',
    );
    const { core, startStream, appendStream, closeStream } = mockCore();

    await encoder.encode({ type: 'x-start', item_id: 'm1', content_index: 2 }, core, ctx);
    await encoder.encode({ type: 'x-delta', item_id: 'm1', content_index: 2, delta: 'Hel' }, core, ctx);
    await encoder.encode({ type: 'x-end', item_id: 'm1', content_index: 2, text: 'Hel' }, core, ctx);

    expect(startStream).toHaveBeenCalledWith('m1:2', expect.anything(), undefined);
    expect(appendStream).toHaveBeenCalledWith('m1:2', 'Hel');
    expect(closeStream).toHaveBeenCalledWith('m1:2', expect.anything());
  });

  it('relocates the id per phase — nested on the start, top-level on continuations', async () => {
    const encoder = createOutputDescriptorEncoder<U>(
      [
        stream('y', {
          start: 'y-start',
          delta: 'y-delta',
          end: 'y-end',
          streamId: (chunk) => ('item' in chunk ? chunk.item.id : chunk.item_id),
          deltaField: 'delta',
          fields: [],
        }),
      ],
      'ai-output',
    );
    const { core, startStream, appendStream } = mockCore();

    await encoder.encode({ type: 'y-start', item: { id: 'fc_9' } }, core, ctx);
    await encoder.encode({ type: 'y-delta', item_id: 'fc_9', delta: '{"loc' }, core, ctx);

    expect(startStream).toHaveBeenCalledWith('fc_9', expect.anything(), undefined);
    expect(appendStream).toHaveBeenCalledWith('fc_9', '{"loc');
  });

  it('surfaces an extractor throw from the encode call', async () => {
    const encoder = createOutputDescriptorEncoder<U>(
      [
        stream('y', {
          start: 'y-start',
          delta: 'y-delta',
          end: 'y-end',
          streamId: () => {
            throw new Error('no id on this chunk');
          },
          deltaField: 'delta',
          fields: [],
        }),
      ],
      'ai-output',
    );
    const { core, startStream } = mockCore();

    await expect(encoder.encode({ type: 'y-start', item: { id: 'fc_9' } }, core, ctx)).rejects.toThrow(
      'no id on this chunk',
    );
    expect(startStream).not.toHaveBeenCalled();
  });
});
