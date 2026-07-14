import { describe, it, expect } from 'vitest';
import { generateChannelSlug, generateClientName } from '../lib/channel-name';

describe('generateClientName', () => {
  it('returns two lowercase words joined by a single hyphen', () => {
    for (let i = 0; i < 50; i++) {
      const parts = generateClientName().split('-');
      expect(parts).toHaveLength(2);
      expect(parts.every((word) => /^[a-z]+$/.test(word))).toBe(true);
    }
  });
});

describe('generateChannelSlug', () => {
  it('returns three lowercase words joined by hyphens', () => {
    for (let i = 0; i < 50; i++) {
      const parts = generateChannelSlug().split('-');
      expect(parts).toHaveLength(3);
      expect(parts.every((word) => /^[a-z]+$/.test(word))).toBe(true);
    }
  });
});
