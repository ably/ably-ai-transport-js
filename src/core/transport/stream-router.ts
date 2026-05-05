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
  /** Register a new stream for a runId. Returns the ReadableStream the consumer reads from. */
  createStream(runId: string): ReadableStream<TEvent>;
  /** Close the stream for a runId. Returns true if a stream existed. */
  closeStream(runId: string): boolean;
  /** Error the stream for a runId. The consumer's reader will reject with the given error. Returns true if a stream existed. */
  errorStream(runId: string, error: Ably.ErrorInfo): boolean;
  /** Enqueue an event to the correct stream. Returns true if routed successfully. */
  route(runId: string, event: TEvent): boolean;
  /** Whether a specific runId has an active stream. */
  has(runId: string): boolean;
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

  createStream(runId: string): ReadableStream<TEvent> {
    this._logger.trace('StreamRouter.createStream();', { runId });

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
    this._runs.set(runId, { controller: entry.controller, runId });
    return stream;
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
  route(runId: string, event: TEvent): boolean {
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
export const createStreamRouter = <TEvent>(
  isTerminal: (event: TEvent) => boolean,
  logger: Logger,
): StreamRouter<TEvent> => new DefaultStreamRouter(isTerminal, logger);
