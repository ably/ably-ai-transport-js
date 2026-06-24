import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import { isToolPart, isUnresolvedToolPart } from '../../src/vercel/tool-part.js';

// CAST: minimal UIMessage parts shaped for the guard under test.
const part = (p: object): AI.UIMessage['parts'][number] => p as AI.UIMessage['parts'][number];

const toolPart = (state: string): AI.UIMessage['parts'][number] =>
  part({ type: 'dynamic-tool', toolCallId: 'c1', toolName: 'echo', state });

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

describe('isUnresolvedToolPart', () => {
  it('is true for states where a tool call is emitted but unresolved', () => {
    // The call has been produced but no result/decision is folded yet — feeding
    // it to a prompt would leave a dangling tool_use.
    expect(isUnresolvedToolPart(toolPart('input-streaming'))).toBe(true);
    expect(isUnresolvedToolPart(toolPart('input-available'))).toBe(true);
    expect(isUnresolvedToolPart(toolPart('approval-requested'))).toBe(true);
  });

  it('is false for resolved states (a matching result or decision is present)', () => {
    expect(isUnresolvedToolPart(toolPart('output-available'))).toBe(false);
    expect(isUnresolvedToolPart(toolPart('output-error'))).toBe(false);
    expect(isUnresolvedToolPart(toolPart('output-denied'))).toBe(false);
    // approval-responded re-runs the tool this turn, so it is not dangling.
    expect(isUnresolvedToolPart(toolPart('approval-responded'))).toBe(false);
  });

  it('is false for non-tool parts', () => {
    expect(isUnresolvedToolPart(part({ type: 'text', text: 'hi' }))).toBe(false);
  });
});
