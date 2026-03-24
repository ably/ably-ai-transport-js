/**
 * Client-side stream routing.
 *
 * Maintains a map of turnId to ReadableStreamController. Routes decoded events
 * to the correct stream. Closes streams on terminal events or explicit close.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { TurnEntry } from './types.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Routes decoded events to the correct turn's ReadableStream. */
export interface StreamRouter<TEvent> {
  /** Register a new stream for a turnId. Returns the ReadableStream the consumer reads from. */
  createStream(turnId: string): ReadableStream<TEvent>;
  /** Close the stream for a turnId. Returns true if a stream was closed. */
  closeStream(turnId: string): boolean;
  /** Enqueue an event to the correct stream. Returns true if routed successfully. */
  route(turnId: string, event: TEvent): boolean;
  /** Whether a specific turnId has an active stream. */
  has(turnId: string): boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CT14
class DefaultStreamRouter<TEvent> implements StreamRouter<TEvent> {
  private readonly _turns = new Map<string, TurnEntry<TEvent>>();
  private readonly _isTerminal: (event: TEvent) => boolean;
  private readonly _logger: Logger;

  constructor(isTerminal: (event: TEvent) => boolean, logger: Logger) {
    this._isTerminal = isTerminal;
    this._logger = logger;
  }

  createStream(turnId: string): ReadableStream<TEvent> {
    this._logger.trace('StreamRouter.createStream();', { turnId });

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
        ErrorCode.TransportSubscriptionError,
        500,
      );
    }
    this._turns.set(turnId, { controller: entry.controller, turnId });
    return stream;
  }

  // Spec: AIT-CT14b
  closeStream(turnId: string): boolean {
    const turn = this._turns.get(turnId);
    if (!turn) return false;

    this._logger.debug('StreamRouter.closeStream(); closing stream', { turnId });
    try {
      turn.controller.close();
    } catch {
      /* already closed */
    }
    this._turns.delete(turnId);
    return true;
  }

  // Spec: AIT-CT14a
  route(turnId: string, event: TEvent): boolean {
    const turn = this._turns.get(turnId);
    if (!turn) return false;

    try {
      turn.controller.enqueue(event);
    } catch {
      this._turns.delete(turnId);
      return false;
    }

    if (this._isTerminal(event)) {
      this.closeStream(turnId);
    }
    return true;
  }

  has(turnId: string): boolean {
    return this._turns.has(turnId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a StreamRouter that routes decoded events to per-turn ReadableStreams.
 * @param isTerminal - Predicate that returns true for events that close the stream.
 * @param logger - Logger for diagnostic output.
 * @returns A new {@link StreamRouter} instance.
 */
export const createStreamRouter = <TEvent>(
  isTerminal: (event: TEvent) => boolean,
  logger: Logger,
): StreamRouter<TEvent> => new DefaultStreamRouter(isTerminal, logger);
