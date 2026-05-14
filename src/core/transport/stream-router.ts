/**
 * Client-side stream routing.
 *
 * Maintains a map of runId to ReadableStreamController. Routes decoded events
 * to the correct stream. Closes streams on terminal events, explicit close, or
 * error.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { RunEntry } from './types.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Routes decoded events to the correct run's ReadableStream. */
export interface StreamRouter<TEvent> {
  /** Register a new stream for a (runId, invocationId). Returns the ReadableStream the consumer reads from. */
  createStream(runId: string, invocationId: string): ReadableStream<TEvent>;
  /**
   * Rebind an existing run's stream to a new invocation-id. Used when a
   * suspended run resumes under the same runId with a fresh invocation —
   * the ReadableStream the consumer is already reading stays open; only
   * the invocation filter advances. Returns the existing ReadableStream on
   * success, or `undefined` (and does nothing) if no stream is registered
   * for the runId.
   */
  rebindStream(runId: string, newInvocationId: string): ReadableStream<TEvent> | undefined;
  /** Close the stream for a runId. Returns true if a stream existed. */
  closeStream(runId: string): boolean;
  /** Error the stream for a runId. The consumer's reader will reject with the given error. Returns true if a stream existed. */
  errorStream(runId: string, error: Ably.ErrorInfo): boolean;
  /**
   * Enqueue an event to the correct stream. Returns true if routed successfully.
   * Drops the event if no stream is registered for the runId, or if the
   * registered stream is bound to a different invocationId.
   */
  route(runId: string, invocationId: string | undefined, event: TEvent): boolean;
  /** Whether a specific runId has an active stream. */
  has(runId: string): boolean;
  /** The invocation-id currently bound to the run's stream, if any. */
  getActiveInvocation(runId: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CT14
class DefaultStreamRouter<TEvent> implements StreamRouter<TEvent> {
  private readonly _runs = new Map<string, RunEntry<TEvent>>();
  private readonly _isTerminal: (event: TEvent) => boolean;
  private readonly _logger: Logger;

  constructor(isTerminal: (event: TEvent) => boolean, logger: Logger) {
    this._isTerminal = isTerminal;
    this._logger = logger;
  }

  createStream(runId: string, invocationId: string): ReadableStream<TEvent> {
    this._logger.trace('StreamRouter.createStream();', { runId, invocationId });

    // Build stream+controller together. ReadableStream's start() runs synchronously
    // per spec, so the controller is captured before the constructor returns.
    const entry: { controller?: ReadableStreamDefaultController<TEvent> } = {};
    const stream = new ReadableStream<TEvent>({
      start(controller) {
        entry.controller = controller;
      },
    });
    if (!entry.controller) {
      throw new Ably.ErrorInfo(
        'unable to create stream; ReadableStream start() was not called synchronously',
        ErrorCode.SessionSubscriptionError,
        500,
      );
    }
    this._runs.set(runId, { stream, controller: entry.controller, runId, invocationId });
    return stream;
  }

  rebindStream(runId: string, newInvocationId: string): ReadableStream<TEvent> | undefined {
    const run = this._runs.get(runId);
    if (!run) return undefined;
    this._logger.debug('StreamRouter.rebindStream();', {
      runId,
      from: run.invocationId,
      to: newInvocationId,
    });
    run.invocationId = newInvocationId;
    return run.stream;
  }

  // Spec: AIT-CT14b
  closeStream(runId: string): boolean {
    const run = this._runs.get(runId);
    if (!run) return false;

    this._logger.debug('StreamRouter.closeStream(); closing stream', { runId });
    try {
      run.controller.close();
    } catch {
      /* consumer cancelled the stream */
    }
    this._runs.delete(runId);
    return true;
  }

  // Spec: AIT-CT14c
  errorStream(runId: string, error: Ably.ErrorInfo): boolean {
    const run = this._runs.get(runId);
    if (!run) return false;

    this._logger.debug('StreamRouter.errorStream(); erroring stream', { runId });
    try {
      run.controller.error(error);
    } catch {
      /* consumer cancelled the stream */
    }
    this._runs.delete(runId);
    return true;
  }

  // Spec: AIT-CT14a
  route(runId: string, invocationId: string | undefined, event: TEvent): boolean {
    const run = this._runs.get(runId);
    if (!run) return false;

    // Drop events whose invocation-id doesn't match the bound stream.
    // Events with no invocation-id header (e.g. agent-side events that
    // don't carry it on every message) are routed to the registered
    // stream — only an explicit mismatch is filtered.
    if (invocationId !== undefined && invocationId !== run.invocationId) {
      this._logger.debug('StreamRouter.route(); dropping mismatched-invocation event', {
        runId,
        eventInvocationId: invocationId,
        streamInvocationId: run.invocationId,
      });
      return false;
    }

    try {
      run.controller.enqueue(event);
    } catch {
      this._runs.delete(runId);
      return false;
    }

    if (this._isTerminal(event)) {
      this.closeStream(runId);
    }
    return true;
  }

  has(runId: string): boolean {
    return this._runs.has(runId);
  }

  getActiveInvocation(runId: string): string | undefined {
    return this._runs.get(runId)?.invocationId;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a StreamRouter that routes decoded events to per-run ReadableStreams.
 * @param isTerminal - Predicate that returns true for events that close the stream.
 * @param logger - Logger for diagnostic output.
 * @returns A new {@link StreamRouter} instance.
 */
export const createStreamRouter = <TEvent>(
  isTerminal: (event: TEvent) => boolean,
  logger: Logger,
): StreamRouter<TEvent> => new DefaultStreamRouter(isTerminal, logger);
