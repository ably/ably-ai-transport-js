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
  const startStream = vi.fn<EncoderCore['startStream']>(async () => {
    await Promise.resolve();
  });
  const appendStream = vi.fn();
  const closeStream = vi.fn(async () => {
    await Promise.resolve();
  });
  const publishDiscrete = vi.fn<EncoderCore['publishDiscrete']>(async () => await Promise.resolve({ serials: [] }));
  const core: EncoderCore = {
    publishDiscrete,
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
  return { core, startStream, appendStream, closeStream, publishDiscrete };
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

// Two stream families share one start type (`part.added`), told apart by
// `part.type`; a third `part.type` matches neither and declines to the discrete
// `event('part.added')` descriptor.
type StartU =
  | { type: 'part.added'; item_id: string; part: { type: 'text' | 'refusal' | 'other' } }
  | { type: 'text.delta'; item_id: string; delta: string }
  | { type: 'text.done'; item_id: string; text: string }
  | { type: 'refusal.delta'; item_id: string; delta: string }
  | { type: 'refusal.done'; item_id: string; refusal: string };

const startB = outputBuilder<StartU>();
const discriminatedEncoder = createOutputDescriptorEncoder<StartU>(
  [
    startB.stream('text', {
      start: 'part.added',
      delta: 'text.delta',
      end: 'text.done',
      streamId: (c) => c.item_id,
      deltaField: 'delta',
      fields: [fItemId],
      startWhen: (c) => c.part.type === 'text',
    }),
    startB.stream('refusal', {
      start: 'part.added',
      delta: 'refusal.delta',
      end: 'refusal.done',
      streamId: (c) => c.item_id,
      deltaField: 'delta',
      fields: [fItemId],
      startWhen: (c) => c.part.type === 'refusal',
    }),
    // The decline target: a `part.added` matching no family's discriminator.
    startB.event('part.added', { fields: [fItemId] }),
  ],
  'ai-output',
);

describe('output descriptor encoder — discriminated start', () => {
  it('resolves a shared start type to the family named by startWhen', async () => {
    const { core, startStream, publishDiscrete } = mockCore();
    await discriminatedEncoder.encode({ type: 'part.added', item_id: 'm1', part: { type: 'text' } }, core, ctx);
    await discriminatedEncoder.encode({ type: 'part.added', item_id: 'm2', part: { type: 'refusal' } }, core, ctx);

    // Each shared start resolves to a different family — the `kind` header is the
    // family id, so kind:text / kind:refusal proves startWhen picked each one.
    const starts = startStream.mock.calls;
    expect(starts).toHaveLength(2);
    expect(starts[0]?.[0]).toBe('m1');
    expect(starts[0]?.[1].codecHeaders).toMatchObject({ kind: 'text', item_id: 'm1' });
    expect(starts[1]?.[0]).toBe('m2');
    expect(starts[1]?.[1].codecHeaders).toMatchObject({ kind: 'refusal', item_id: 'm2' });
    expect(publishDiscrete).not.toHaveBeenCalled();
  });

  it('declines a start matching no family, falling through to the discrete event()', async () => {
    const { core, startStream, publishDiscrete } = mockCore();
    await discriminatedEncoder.encode({ type: 'part.added', item_id: 'm3', part: { type: 'other' } }, core, ctx);

    expect(startStream).not.toHaveBeenCalled();
    expect(publishDiscrete).toHaveBeenCalledTimes(1);
    expect(publishDiscrete.mock.calls[0]?.[0].codecHeaders).toMatchObject({ kind: 'part.added', item_id: 'm3' });
  });

  it('drives a discriminated family through start → delta → end on its own stream', async () => {
    const { core, startStream, appendStream, closeStream } = mockCore();
    // The `part.added` opens the text family; its delta and done then continue and
    // close that same stream — the family the discriminator picked owns the whole
    // lifecycle, not just the start's header.
    await discriminatedEncoder.encode({ type: 'part.added', item_id: 'm1', part: { type: 'text' } }, core, ctx);
    await discriminatedEncoder.encode({ type: 'text.delta', item_id: 'm1', delta: 'Hel' }, core, ctx);
    await discriminatedEncoder.encode({ type: 'text.done', item_id: 'm1', text: 'Hello' }, core, ctx);

    const start = startStream.mock.calls[0];
    expect(start?.[0]).toBe('m1');
    expect(start?.[1].codecHeaders).toMatchObject({ kind: 'text' });
    expect(appendStream).toHaveBeenCalledWith('m1', 'Hel');
    expect(closeStream).toHaveBeenCalledWith('m1', expect.anything());
  });
});
