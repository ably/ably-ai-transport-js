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
import type { CodecOutputEvent } from '../codec/types.js';
import type { RunEntry } from './types.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Routes decoded events to the correct run's ReadableStream. */
export interface StreamRouter<TOutput extends CodecOutputEvent> {
  /** Register a new stream for a runId. Returns the ReadableStream the consumer reads from. */
  createStream(runId: string): ReadableStream<TOutput>;
  /**
   * Return the existing stream for a runId, or `undefined` if none is
   * registered. Used on continuation: a suspended run that resumes under
   * the same runId re-exposes the ReadableStream the consumer is already
   * reading rather than opening a new one.
   */
  getStream(runId: string): ReadableStream<TOutput> | undefined;
  /** Close the stream for a runId. Returns true if a stream existed. */
  closeStream(runId: string): boolean;
  /** Error the stream for a runId. The consumer's reader will reject with the given error. Returns true if a stream existed. */
  errorStream(runId: string, error: Ably.ErrorInfo): boolean;
  /**
   * Enqueue an event to the run's stream. Returns true if routed
   * successfully. Drops the event if no stream is registered for the runId.
   */
  route(runId: string, event: TOutput): boolean;
  /** Whether a specific runId has an active stream. */
  has(runId: string): boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CT14
class DefaultStreamRouter<TOutput extends CodecOutputEvent> implements StreamRouter<TOutput> {
  private readonly _runs = new Map<string, RunEntry<TOutput>>();
  private readonly _isTerminal: (event: TOutput) => boolean;
  private readonly _logger: Logger;

  constructor(isTerminal: (event: TOutput) => boolean, logger: Logger) {
    this._isTerminal = isTerminal;
    this._logger = logger;
  }

  createStream(runId: string): ReadableStream<TOutput> {
    this._logger.trace('StreamRouter.createStream();', { runId });

    // Build stream+controller together. ReadableStream's start() runs synchronously
    // per spec, so the controller is captured before the constructor returns.
    const entry: { controller?: ReadableStreamDefaultController<TOutput> } = {};
    const stream = new ReadableStream<TOutput>({
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
    this._runs.set(runId, { stream, controller: entry.controller, runId });
    return stream;
  }

  getStream(runId: string): ReadableStream<TOutput> | undefined {
    return this._runs.get(runId)?.stream;
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
  route(runId: string, event: TOutput): boolean {
    const run = this._runs.get(runId);
    if (!run) return false;

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
export const createStreamRouter = <TOutput extends CodecOutputEvent>(
  isTerminal: (event: TOutput) => boolean,
  logger: Logger,
): StreamRouter<TOutput> => new DefaultStreamRouter(isTerminal, logger);
