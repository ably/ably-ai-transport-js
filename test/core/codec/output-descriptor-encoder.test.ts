import { describe, expect, it, vi } from 'vitest';

import type { EncoderCore } from '../../../src/core/codec/encoder.js';
import { strField } from '../../../src/core/codec/fields.js';
import { createOutputDescriptorEncoder } from '../../../src/core/codec/output-descriptor-encoder.js';
import { outputBuilder } from '../../../src/core/codec/output-descriptors.js';

// Two stream families share one start type (`part.added`), told apart by
// `part.type`; a third `part.type` matches neither and must decline to the
// discrete `event('part.added')` descriptor.
type U =
  | { type: 'part.added'; item_id: string; part: { type: 'text' | 'refusal' | 'other' } }
  | { type: 'text.delta'; item_id: string; delta: string }
  | { type: 'text.done'; item_id: string; text: string }
  | { type: 'refusal.delta'; item_id: string; delta: string }
  | { type: 'refusal.done'; item_id: string; refusal: string };

const fItemId = strField('item_id');
const { stream, event } = outputBuilder<U>();

const encoder = createOutputDescriptorEncoder<U>(
  [
    stream('text', {
      start: 'part.added',
      delta: 'text.delta',
      end: 'text.done',
      streamId: { field: 'item_id' },
      deltaField: 'delta',
      fields: [fItemId],
      startWhen: (c) => c.part.type === 'text',
    }),
    stream('refusal', {
      start: 'part.added',
      delta: 'refusal.delta',
      end: 'refusal.done',
      streamId: { field: 'item_id' },
      deltaField: 'delta',
      fields: [fItemId],
      startWhen: (c) => c.part.type === 'refusal',
    }),
    // The decline target: a `part.added` matching no family's discriminator.
    event('part.added', { fields: [fItemId] }),
  ],
  'ai-output',
);

// Reference the vi.fn mocks directly (not extracted from `core`) so assertions
// don't trip the unbound-method rule.
const makeCore = () => {
  // The encoder driver never reads a core method's return value, so the mocks
  // need no implementation — they only record calls.
  const startStream = vi.fn<EncoderCore['startStream']>();
  const appendStream = vi.fn<EncoderCore['appendStream']>();
  const closeStream = vi.fn<EncoderCore['closeStream']>();
  const publishDiscrete = vi.fn<EncoderCore['publishDiscrete']>();
  const core: EncoderCore = {
    publishDiscrete,
    publishDiscreteBatch: vi.fn<EncoderCore['publishDiscreteBatch']>(),
    startStream,
    appendStream,
    closeStream,
    cancelAllStreams: vi.fn<EncoderCore['cancelAllStreams']>(),
    close: vi.fn<EncoderCore['close']>(),
  };
  return { core, startStream, appendStream, closeStream, publishDiscrete };
};

const ctx = { messageId: undefined, opts: undefined };

describe('output descriptor encoder — discriminated start (Cap 3)', () => {
  it('resolves a shared start type to the family named by startWhen', async () => {
    const { core, startStream, publishDiscrete } = makeCore();
    await encoder.encode({ type: 'part.added', item_id: 'm1', part: { type: 'text' } }, core, ctx);
    await encoder.encode({ type: 'part.added', item_id: 'm2', part: { type: 'refusal' } }, core, ctx);

    const starts = startStream.mock.calls;
    expect(starts).toHaveLength(2);
    expect(starts[0]?.[0]).toBe('m1');
    expect(starts[0]?.[1].codecHeaders).toMatchObject({ kind: 'text', item_id: 'm1' });
    expect(starts[1]?.[0]).toBe('m2');
    expect(starts[1]?.[1].codecHeaders).toMatchObject({ kind: 'refusal', item_id: 'm2' });
    expect(publishDiscrete).not.toHaveBeenCalled();
  });

  it('declines a start matching no family, falling through to the discrete event()', async () => {
    const { core, startStream, publishDiscrete } = makeCore();
    await encoder.encode({ type: 'part.added', item_id: 'm3', part: { type: 'other' } }, core, ctx);

    expect(startStream).not.toHaveBeenCalled();
    expect(publishDiscrete).toHaveBeenCalledTimes(1);
    expect(publishDiscrete.mock.calls[0]?.[0].codecHeaders).toMatchObject({ kind: 'part.added', item_id: 'm3' });
  });

  it('routes a delta continuation to its family (unique per type)', async () => {
    const { core, startStream, appendStream } = makeCore();
    await encoder.encode({ type: 'text.delta', item_id: 'm1', delta: 'Hel' }, core, ctx);

    expect(appendStream).toHaveBeenCalledWith('m1', 'Hel');
    expect(startStream).not.toHaveBeenCalled();
  });
});
