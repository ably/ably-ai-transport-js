import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import { isToolPart } from '../../src/vercel/tool-part.js';

// CAST: minimal UIMessage parts shaped for the guard under test.
const part = (p: object): AI.UIMessage['parts'][number] => p as AI.UIMessage['parts'][number];

describe('isToolPart', () => {
  it('accepts the codec-normalised dynamic-tool shape', () => {
    expect(isToolPart(part({ type: 'dynamic-tool', toolCallId: 'c1', state: 'input-available' }))).toBe(true);
  });

  it('accepts the AI SDK tool-${name} shape', () => {
    expect(isToolPart(part({ type: 'tool-getWeather', toolCallId: 'c1', state: 'output-available' }))).toBe(true);
  });

  it('rejects non-tool parts', () => {
    expect(isToolPart(part({ type: 'text', text: 'hi' }))).toBe(false);
    expect(isToolPart(part({ type: 'step-start' }))).toBe(false);
  });

  it('rejects a tool-prefixed part missing toolCallId/state', () => {
    expect(isToolPart(part({ type: 'tool-getWeather' }))).toBe(false);
    expect(isToolPart(part({ type: 'dynamic-tool', toolCallId: 'c1' }))).toBe(false);
  });
});
