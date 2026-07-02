/**
 * Tests for the deterministic-id helpers shipped from
 * `@ably/ai-transport/temporal`.
 */

import { describe, expect, it, vi } from 'vitest';

import { activityInvocationIdFor, stepIdFor } from '../../src/temporal/step-id.js';

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

const mockContext = (workflowId: string | undefined, activityId: string): void => {
  vi.mocked(currentFn).mockReturnValue({
    info: {
      activityId,
      workflowExecution: workflowId === undefined ? undefined : { workflowId, runId: 'wf-run-x' },
    },
    // CAST: only the two `info` fields matter for these tests.
  } as unknown as ReturnType<typeof Context.current>);
};

describe('stepIdFor', () => {
  it('composes a workflow-scoped stepId from the workflow id prefix and activity id', () => {
    expect(stepIdFor('abcdef1234567890', '3')).toBe('abcdef12-3');
  });

  it('shortens the workflow id to 8 characters', () => {
    expect(stepIdFor('12345678', '1')).toBe('12345678-1');
    // A shorter workflow id still passes through untouched (slice(0,8) is safe).
    expect(stepIdFor('short', '1')).toBe('short-1');
  });

  it('does not depend on Context — pure function of its arguments', () => {
    // Called without any @temporalio Context mock in place. Purity check.
    // Ids must differ within the first 8 chars — that's the prefix window.
    const a = stepIdFor('aaaaaaaa-first', '1');
    const b = stepIdFor('bbbbbbbb-second', '1');
    expect(a).not.toBe(b);
    expect(a).toBe('aaaaaaaa-1');
    expect(b).toBe('bbbbbbbb-1');
  });
});

describe('activityInvocationIdFor', () => {
  it('composes a workflow-scoped invocation id from the current context', () => {
    mockContext('abcdef1234567890', '3');
    expect(activityInvocationIdFor()).toBe('abcdef12-3');
  });

  it('falls back to a `nowf` prefix when the activity has no workflowExecution', () => {
    // Real Temporal workflows always populate workflowExecution, but the
    // type is optional — a directly-invoked activity in tests may lack it.
    mockContext(undefined, '5');
    expect(activityInvocationIdFor()).toBe('nowf-5');
  });

  it('shortens the workflow id to 8 characters', () => {
    mockContext('12345678abcdef', '1');
    expect(activityInvocationIdFor()).toBe('12345678-1');
  });
});
