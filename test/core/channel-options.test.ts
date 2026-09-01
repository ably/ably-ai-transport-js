/**
 * Unit tests for the shared channel-mode resolver.
 *
 * Covers: opt-out (undefined when no extra modes), union with the base set,
 * de-duplication, canonical ordering, and determinism across calls — the
 * properties `<ClientTransportProvider>` and the `<ChannelProvider>` it renders
 * rely on to request identical modes and avoid spurious reattaches.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { AIT_BASE_MODES, OBJECT_MODES, resolveChannelModes } from '../../src/core/channel-options.js';

describe('resolveChannelModes', () => {
  it('returns undefined when no extra modes are requested', () => {
    expect(resolveChannelModes()).toBeUndefined();
    expect(resolveChannelModes([])).toBeUndefined();
  });

  it('unions the base modes with the requested extras', () => {
    const resolved = resolveChannelModes(OBJECT_MODES);
    // Every base mode and every object mode must be present.
    for (const mode of [...AIT_BASE_MODES, ...OBJECT_MODES]) {
      expect(resolved).toContain(mode);
    }
  });

  it('emits the object-enabled set in canonical order', () => {
    expect(resolveChannelModes(OBJECT_MODES)).toEqual([
      'PUBLISH',
      'SUBSCRIBE',
      'PRESENCE',
      'PRESENCE_SUBSCRIBE',
      'OBJECT_PUBLISH',
      'OBJECT_SUBSCRIBE',
      'ANNOTATION_PUBLISH',
    ]);
  });

  it('de-duplicates modes already present in the base set', () => {
    const resolved = resolveChannelModes(['PUBLISH', 'OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH']);
    const publishCount = resolved?.filter((mode) => mode === 'PUBLISH').length;
    expect(publishCount).toBe(1);
  });

  it('produces an identical array regardless of the order of the extras', () => {
    const a = resolveChannelModes(['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH']);
    const b = resolveChannelModes(['OBJECT_PUBLISH', 'OBJECT_SUBSCRIBE']);
    expect(a).toEqual(b);
  });

  it('does not include object modes when only base modes are requested', () => {
    const resolved = resolveChannelModes(['PRESENCE']);
    expect(resolved).not.toContain('OBJECT_SUBSCRIBE');
    expect(resolved).not.toContain('OBJECT_PUBLISH');
  });

  it('appends modes outside the canonical order after the canonical modes, alphabetically', () => {
    // Lowercase aliases are valid ChannelMode values but are not in the
    // canonical uppercase order; they must still resolve deterministically.
    const extras: Ably.ChannelMode[] = ['object_subscribe', 'annotation_subscribe'];
    expect(resolveChannelModes(extras)).toEqual([
      'PUBLISH',
      'SUBSCRIBE',
      'PRESENCE',
      'PRESENCE_SUBSCRIBE',
      'ANNOTATION_PUBLISH',
      'annotation_subscribe',
      'object_subscribe',
    ]);
  });
});
