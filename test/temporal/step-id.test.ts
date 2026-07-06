/**
 * Tests for the deterministic-id helper shipped from
 * `@ably/ai-transport/temporal`.
 */

import { describe, expect, it, vi } from 'vitest';

import { stepIdFor } from '../../src/temporal/step-id.js';

// Mock @temporalio/activity so we can drive Context.current() from tests.
vi.mock('@temporalio/activity', () => ({
  Context: {
    current: vi.fn(),
  },
}));

// Import AFTER the mock so the mocked module is used.
import { Context } from '@temporalio/activity';

// eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accepts the static method reference; it does not read `this`.
const currentFn = Context.current;

const mockContext = (activityId: string): void => {
  vi.mocked(currentFn).mockReturnValue({
    info: { activityId },
    // CAST: only `info.activityId` matters for these tests.
  } as unknown as ReturnType<typeof Context.current>);
};

describe('stepIdFor', () => {
  it('composes a workflow-scoped stepId from the full invocation id and the current activity id', () => {
    mockContext('3');
    expect(stepIdFor('abcdef1234567890')).toBe('abcdef1234567890-3');
  });

  it('preserves the full invocation id — no truncation', () => {
    mockContext('1');
    // Prefixed ids that would collapse to the same 8-char prefix must not collide.
    expect(stepIdFor('agent-run-abc123')).toBe('agent-run-abc123-1');
    expect(stepIdFor('agent-run-xyz789')).toBe('agent-run-xyz789-1');
  });

  it('reads the activity id live from Context.current()', () => {
    // Same invocation id, different activity contexts → distinct step ids.
    mockContext('1');
    const first = stepIdFor('aaaaaaaa');
    mockContext('2');
    const second = stepIdFor('aaaaaaaa');
    expect(first).toBe('aaaaaaaa-1');
    expect(second).toBe('aaaaaaaa-2');
  });
});
