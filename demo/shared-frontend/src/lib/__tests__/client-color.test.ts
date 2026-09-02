import { describe, it, expect } from 'vitest';

import { clientColor } from '../client-color';

// clientColor hashes a clientId to a stable palette entry so the same client
// reads as the same colour everywhere in the UI.

describe('clientColor', () => {
  it('returns the same colour for the same clientId (stable hash)', () => {
    expect(clientColor('galaxy-saffron')).toEqual(clientColor('galaxy-saffron'));
  });

  it('returns an object shaped { text, primary, avatarBg }', () => {
    const color = clientColor('abcuser');
    expect(Object.keys(color).sort()).toEqual(['avatarBg', 'primary', 'text']);
    expect(color.text).toMatch(/^text-/);
    expect(color.avatarBg).toMatch(/^bg-/);
    expect(color.primary).toMatch(/^oklch\(/);
  });

  it('maps an empty clientId to a valid palette entry', () => {
    const color = clientColor('');
    expect(color.text).toMatch(/^text-/);
    expect(color.avatarBg).toMatch(/^bg-/);
  });

  it('spreads different clientIds across more than one palette colour', () => {
    const distinct = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'].map(
        (id) => clientColor(id).text,
      ),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });
});
