import { describe, expect, it } from 'vitest';
import { checklistFrom } from '../lib/checklist';

describe('checklistFrom', () => {
  it('maps a valid steps record to rows in checklist order', () => {
    const rows = checklistFrom({
      '1': { text: 'Gather requirements', status: 'done', updatedAt: 30 },
      '2': { text: 'Draft the outline', status: 'active', updatedAt: 20 },
      '3': { text: 'Write the summary', status: 'pending', updatedAt: 10 },
    });
    expect(rows).toEqual([
      { index: 1, text: 'Gather requirements', status: 'done', updatedAt: 30 },
      { index: 2, text: 'Draft the outline', status: 'active', updatedAt: 20 },
      { index: 3, text: 'Write the summary', status: 'pending', updatedAt: 10 },
    ]);
  });

  it('orders by step number, not by updatedAt or key insertion order', () => {
    const rows = checklistFrom({
      '10': { text: 'ten', status: 'pending', updatedAt: 1 },
      '2': { text: 'two', status: 'pending', updatedAt: 99 },
      '1': { text: 'one', status: 'pending', updatedAt: 50 },
    });
    expect(rows.map((r) => r.index)).toEqual([1, 2, 10]);
  });

  it('drops entries with a bad field or a non-positive-integer key', () => {
    const rows = checklistFrom({
      '1': { text: 'ok', status: 'pending', updatedAt: 1 },
      '2': { text: 'no status', updatedAt: 2 },
      '3': { text: 'bad status', status: 'blocked', updatedAt: 3 },
      '4': { text: 42, status: 'done', updatedAt: 4 },
      '5': { text: 'bad time', status: 'done', updatedAt: 'soon' },
      '0': { text: 'zero key', status: 'done', updatedAt: 5 },
      foo: { text: 'named key', status: 'done', updatedAt: 6 },
      '1.5': { text: 'fractional key', status: 'done', updatedAt: 7 },
    });
    expect(rows).toEqual([{ index: 1, text: 'ok', status: 'pending', updatedAt: 1 }]);
  });

  it('returns an empty array for non-record input', () => {
    expect(checklistFrom(undefined)).toEqual([]);
    expect(checklistFrom(null)).toEqual([]);
    expect(checklistFrom('nope')).toEqual([]);
    expect(checklistFrom([1, 2, 3])).toEqual([]);
  });
});
