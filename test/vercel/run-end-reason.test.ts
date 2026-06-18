import * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCode } from '../../src/errors.js';
import { vercelRunOutcome } from '../../src/vercel/run-end-reason.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  // CAST: assigned inside the Promise executor before the function returns.
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('vercelRunOutcome', () => {
  it('returns cancelled when pipe was cancelled without using finishReason value', async () => {
    const result = await vercelRunOutcome({ reason: 'cancelled' }, Promise.resolve<AI.FinishReason>('stop'));
    expect(result.reason).toBe('cancelled');
    expect(result.error).toBeUndefined();
  });

  it('returns error and surfaces the wrapped error when pipe errored without using finishReason value', async () => {
    const result = await vercelRunOutcome(
      { reason: 'error', error: new Error('boom') },
      Promise.resolve<AI.FinishReason>('stop'),
    );
    expect(result.reason).toBe('error');
    expect(result.error).toBeInstanceOf(Ably.ErrorInfo);
    expect(result.error?.code).toBe(ErrorCode.StreamError);
    expect(result.error?.message).toContain('boom');
  });

  it('passes through an error that is already an Ably.ErrorInfo unchanged', async () => {
    const original = new Ably.ErrorInfo('invalid x-api-key', 40003, 400);
    const result = await vercelRunOutcome(
      { reason: 'error', error: original },
      Promise.resolve<AI.FinishReason>('stop'),
    );
    expect(result.reason).toBe('error');
    expect(result.error).toBe(original);
    expect(result.error?.code).toBe(40003);
  });

  it('returns suspend when pipe completed and finishReason is tool-calls', async () => {
    const result = await vercelRunOutcome({ reason: 'complete' }, Promise.resolve('tool-calls'));
    expect(result.reason).toBe('suspend');
    expect(result.error).toBeUndefined();
  });

  it('returns complete when pipe completed and finishReason is stop', async () => {
    const result = await vercelRunOutcome({ reason: 'complete' }, Promise.resolve('stop'));
    expect(result.reason).toBe('complete');
    expect(result.error).toBeUndefined();
  });

  it('returns complete when pipe completed and finishReason is length', async () => {
    const result = await vercelRunOutcome({ reason: 'complete' }, Promise.resolve('length'));
    expect(result.reason).toBe('complete');
    expect(result.error).toBeUndefined();
  });

  it('returns cancelled when finishReason rejects with an abort error', async () => {
    // Vercel AI SDK v6 rejects `streamText().finishReason` with the
    // abort signal's reason (a DOMException whose name is "AbortError")
    // when the stream is aborted before any step completes.
    const abortError = new DOMException('aborted', 'AbortError');
    const result = await vercelRunOutcome({ reason: 'complete' }, Promise.reject(abortError));
    expect(result.reason).toBe('cancelled');
    expect(result.error).toBeUndefined();
  });

  it('returns cancelled when finishReason rejects with a non-DOMException abort-shaped error', async () => {
    // Some runtimes surface aborts as a plain Error with name === 'AbortError'
    // rather than a DOMException. The mapping should still treat it as cancel.
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const result = await vercelRunOutcome({ reason: 'complete' }, Promise.reject(abortError));
    expect(result.reason).toBe('cancelled');
    expect(result.error).toBeUndefined();
  });

  it('returns error and surfaces the wrapped error when finishReason rejects with a non-abort error', async () => {
    // E.g. Vercel's NoOutputGeneratedError when the stream produced no
    // steps for a reason other than abort. The mapping should surface
    // this as an error-terminated run, wrapped so the caller can stamp it.
    const result = await vercelRunOutcome({ reason: 'complete' }, Promise.reject(new Error('no output')));
    expect(result.reason).toBe('error');
    expect(result.error).toBeInstanceOf(Ably.ErrorInfo);
    expect(result.error?.code).toBe(ErrorCode.StreamError);
    expect(result.error?.message).toContain('no output');
  });

  describe('unhandled rejection regression', () => {
    // Repro for the Next.js dev-mode crash: Vercel's `result.finishReason`
    // getter creates the underlying Promise eagerly, before our route
    // handler hands it to `vercelRunOutcome`. When the pipe ended in a
    // non-`'complete'` state (the cancel path) we used to return without
    // ever attaching a handler to that promise. If Vercel rejected it
    // later (which it does when `streamText` aborts before any step),
    // Node reported an unhandled rejection and Next.js' dev bundler
    // crashed trying to mutate the DOMException's read-only `.message`.
    let unhandled: { reason: unknown; promise: Promise<unknown> }[];
    const onUnhandled = (reason: unknown, promise: Promise<unknown>): void => {
      unhandled.push({ reason, promise });
    };

    beforeEach(() => {
      unhandled = [];
      process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    it('does not leak an unhandled rejection when pipe was cancelled and finishReason later rejects', async () => {
      // Simulate Vercel's lazy rejection: the promise is pending when
      // vercelRunOutcome is called, then rejects asynchronously.
      const deferred = createDeferred<AI.FinishReason>();

      const result = await vercelRunOutcome({ reason: 'cancelled' }, deferred.promise);
      expect(result.reason).toBe('cancelled');

      // Now reject after vercelRunOutcome has returned. A naive
      // implementation that returned early without attaching a handler
      // would surface this as an unhandled rejection.
      deferred.reject(new DOMException('aborted', 'AbortError'));

      // Wait two macrotask flushes so Node's promise-rejection scanner
      // has time to log unhandledRejection if a handler is missing.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(unhandled).toEqual([]);
    });

    it('does not leak an unhandled rejection when pipe errored and finishReason later rejects', async () => {
      const deferred = createDeferred<AI.FinishReason>();

      const result = await vercelRunOutcome({ reason: 'error', error: new Error('boom') }, deferred.promise);
      expect(result.reason).toBe('error');

      deferred.reject(new DOMException('aborted', 'AbortError'));

      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(unhandled).toEqual([]);
    });
  });
});
