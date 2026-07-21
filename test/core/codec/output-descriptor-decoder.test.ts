import { describe, expect, it } from 'vitest';

import { KIND_HEADER } from '../../../src/core/codec/field-bag.js';
import { jsonField, strField } from '../../../src/core/codec/fields.js';
import { createOutputDescriptorDecoder } from '../../../src/core/codec/output-descriptor-decoder.js';
import { outputBuilder } from '../../../src/core/codec/output-descriptors.js';
import type { StreamTrackerState } from '../../../src/core/codec/types.js';

// A codec union whose delta chunk carries a *different* field set from its start:
// the start (`x-start`) carries `part`; the real delta (`x-delta`) does not, but
// both carry the slot's `item_id` + `content_index` routing coordinates.
type U =
  | { type: 'x-start'; item_id: string; content_index: number; part: { kind: string } }
  | { type: 'x-delta'; item_id: string; content_index: number; delta: string }
  | { type: 'x-end'; item_id: string; content_index: number; text: string };

const fItemId = strField('item_id');
const fContentIndex = jsonField<number, 'content_index'>('content_index');
const fPart = jsonField<{ kind: string }, 'part'>('part');

const { stream } = outputBuilder<U>();

// A tracker as a start publish would leave it: the re-stamped start codec headers.
const trackerWith = (kind: string, streamId: string, codecHeaders: Record<string, string>): StreamTrackerState => ({
  name: 'ai-output',
  streamId,
  accumulated: '',
  codecHeaders: { [KIND_HEADER]: kind, ...codecHeaders },
  transportHeaders: {},
  version: 's1',
  closed: false,
});

describe('output descriptor decoder — delta reconstruction', () => {
  it('rebuilds the delta from the fields that decodeDelta passes to rebuild()', () => {
    const decoder = createOutputDescriptorDecoder<U>([
      stream('x', {
        start: 'x-start',
        delta: 'x-delta',
        end: 'x-end',
        streamId: (c) => c.item_id,
        deltaField: 'delta',
        fields: [fContentIndex, fPart],
        decodeDelta: ({ rebuild }) => rebuild([fItemId, fContentIndex]),
      }),
    ]);

    // `part` rides the start headers (re-stamped on every append), but decodeDelta
    // rebuilds from item_id/content_index only — so the rebuilt delta carries
    // content_index but must not have a `part`.
    const tracker = trackerWith('x', 'm1', {
      item_id: 'm1',
      content_index: '0',
      part: JSON.stringify({ kind: 'text' }),
    });

    expect(decoder.buildDelta(tracker, 'Hel')).toEqual([
      { type: 'x-delta', item_id: 'm1', content_index: 0, delta: 'Hel' },
    ]);
    expect(decoder.buildDelta(tracker, 'Hel')[0]).not.toHaveProperty('part');
  });

  it('rebuilds a delta from the object that decodeDelta returns', () => {
    // The escape-hatch path: instead of `rebuild([...])`, decodeDelta returns a
    // chunk it builds itself, computing a value no header carries (content_index
    // 99, and an upper-cased fragment).
    const decoder = createOutputDescriptorDecoder<U>([
      stream('y', {
        start: 'x-start',
        delta: 'x-delta',
        end: 'x-end',
        streamId: (c) => c.item_id,
        deltaField: 'delta',
        fields: [fContentIndex],
        decodeDelta: ({ delta, codecHeaders }) => [
          { type: 'x-delta', item_id: fItemId.read(codecHeaders) ?? '', content_index: 99, delta: delta.toUpperCase() },
        ],
      }),
    ]);

    const tracker = trackerWith('y', 'm2', { item_id: 'm2', content_index: '0' });

    expect(decoder.buildDelta(tracker, 'abc')).toEqual([
      { type: 'x-delta', item_id: 'm2', content_index: 99, delta: 'ABC' },
    ]);
  });

  it('the idField is reconstructed from the header that idField names, never the transport stream id', () => {
    const decoder = createOutputDescriptorDecoder<U>([
      stream('x', {
        start: 'x-start',
        delta: 'x-delta',
        end: 'x-end',
        streamId: (c) => c.item_id,
        deltaField: 'delta',
        fields: [fItemId, fContentIndex, fPart],
        decodeDelta: ({ rebuild }) => rebuild([fItemId, fContentIndex]),
      }),
    ]);

    // The transport stream id is composite (`m1:0`) — as a derived streamId would
    // produce — but every rebuilt phase carries the real `item_id` ('m1') read
    // from the re-stamped headers, never the transport id (i.e. the stream's `idField` only defines which fields to _read_).
    const tracker = trackerWith('x', 'm1:0', {
      item_id: 'm1',
      content_index: '0',
      part: JSON.stringify({ kind: 'text' }),
    });

    expect(decoder.buildStart(tracker)).toEqual([
      { type: 'x-start', item_id: 'm1', content_index: 0, part: { kind: 'text' } },
    ]);
    expect(decoder.buildDelta(tracker, 'Hi')).toEqual([
      { type: 'x-delta', item_id: 'm1', content_index: 0, delta: 'Hi' },
    ]);
    expect(decoder.buildEnd(tracker, { [KIND_HEADER]: 'x', item_id: 'm1', content_index: '0' })).toEqual([
      { type: 'x-end', item_id: 'm1', content_index: 0 },
    ]);
  });

  it('rebuilds a fragment-only delta when decodeDelta is omitted', () => {
    const decoder = createOutputDescriptorDecoder<U>([
      stream('z', {
        start: 'x-start',
        delta: 'x-delta',
        end: 'x-end',
        streamId: (c) => c.item_id,
        deltaField: 'delta',
        fields: [fItemId],
        // decodeDelta omitted — the delta needs no fields beyond the fragment.
      }),
    ]);

    const tracker = trackerWith('z', 'm9', { item_id: 'm9' });
    expect(decoder.buildDelta(tracker, 'Yo')).toEqual([{ type: 'x-delta', delta: 'Yo' }]);
  });
});
