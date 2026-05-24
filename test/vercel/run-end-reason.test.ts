import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { vercelRunEndReason } from '../../src/vercel/run-end-reason.js';

const finishReasonPromise = (value: AI.FinishReason) => {
  const promise = Promise.resolve(value);
  const thenSpy = vi.spyOn(promise, 'then');
  return { promise, thenSpy };
};

describe('vercelRunEndReason', () => {
  it('returns cancelled without awaiting finishReason when pipe was cancelled', async () => {
    const { promise, thenSpy } = finishReasonPromise('stop');
    const result = await vercelRunEndReason({ reason: 'cancelled' }, promise);
    expect(result).toBe('cancelled');
    expect(thenSpy).not.toHaveBeenCalled();
  });

  it('returns error without awaiting finishReason when pipe errored', async () => {
    const { promise, thenSpy } = finishReasonPromise('stop');
    const result = await vercelRunEndReason({ reason: 'error', error: new Error('boom') }, promise);
    expect(result).toBe('error');
    expect(thenSpy).not.toHaveBeenCalled();
  });

  it('preserves the StreamResult error so callers can surface it via run-end error headers', async () => {
    // The agent publishes `ai-run-end { reason: 'error' }` with
    // `x-ably-error-code` / `x-ably-error-message` headers when given a
    // RunEndError payload. Route handlers reach that payload by reading
    // `StreamResult.error` off the pipe result; `vercelRunEndReason`
    // decides the reason but leaves the StreamResult intact so the
    // caller can construct the payload. This test pins that contract:
    // when the pipe errors, result.error survives unchanged for the
    // caller to forward to `run.end('error', { code, message, ... })`.
    const original = new Error('rate limit exceeded');
    const streamResult = { reason: 'error' as const, error: original };
    const reason = await vercelRunEndReason(streamResult, Promise.resolve('stop'));
    expect(reason).toBe('error');
    expect(streamResult.error).toBe(original);
  });

  it('returns suspended when pipe completed and finishReason is tool-calls', async () => {
    const result = await vercelRunEndReason({ reason: 'complete' }, Promise.resolve('tool-calls'));
    expect(result).toBe('suspended');
  });

  it('returns complete when pipe completed and finishReason is stop', async () => {
    const result = await vercelRunEndReason({ reason: 'complete' }, Promise.resolve('stop'));
    expect(result).toBe('complete');
  });

  it('returns complete when pipe completed and finishReason is length', async () => {
    const result = await vercelRunEndReason({ reason: 'complete' }, Promise.resolve('length'));
    expect(result).toBe('complete');
  });
});
