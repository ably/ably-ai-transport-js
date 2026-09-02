/**
 * Event-recorder scaffolding for transport integration tests.
 *
 * A transport's event stream is a live emitter with no replay: a listener
 * attached after an event fired never sees it. The recorder is the tape —
 * attach it the moment an endpoint exists (before any publish) and every
 * event lands in its buffer, so waiting for an event that already arrived and
 * waiting for one still coming are the same operation.
 *
 * No helper here takes a timeout: tests await events, never clocks, and the
 * vitest `testTimeout` is the only deadline. A hang surfaces as a test
 * timeout with the recorder's buffer available for diagnosis.
 */

import type { RunLifecycleEvent, StepLifecycleEvent, TransportEvent } from '../../src/index.js';

/** The subscription surface both transports expose. */
interface EventSource<TInput, TOutput> {
  /** Subscribe a handler to the classified event stream; returns the unsubscribe. */
  subscribe(handler: (event: TransportEvent<TInput, TOutput>) => void): () => void;
}

/** A recording of one endpoint's event stream. */
export interface EventRecorder<TInput, TOutput> {
  /** Every event observed so far, in arrival order. */
  events: TransportEvent<TInput, TOutput>[];
  /**
   * Resolve with the first event matching `predicate` — from the buffer when
   * one already arrived, else from the live stream. Because the whole buffer
   * is searched, a predicate reused across turns must be scoped to an id the
   * test owns (`transportMessageId`, `runId`), never a bare `kind` check — a
   * loose predicate can match an older turn's event.
   * @param predicate - The match.
   * @returns The first matching event.
   */
  next(predicate: (event: TransportEvent<TInput, TOutput>) => boolean): Promise<TransportEvent<TInput, TOutput>>;
  /**
   * Resolve with every event observed up to and including the first match of
   * `predicate` (same buffer-then-live semantics and id-scoping caveat as
   * {@link next}).
   * @param predicate - The match that ends the collection.
   * @returns The events up to and including the match.
   */
  until(predicate: (event: TransportEvent<TInput, TOutput>) => boolean): Promise<TransportEvent<TInput, TOutput>[]>;
  /** Unsubscribe the recorder from the transport. */
  stop(): void;
}

/**
 * Attach a recorder to a transport's event stream. Attach at endpoint
 * creation, before any publish, so nothing can be missed.
 * @param source - The transport to record.
 * @returns The recorder.
 */
export const recordEvents = <TInput, TOutput>(source: EventSource<TInput, TOutput>): EventRecorder<TInput, TOutput> => {
  const events: TransportEvent<TInput, TOutput>[] = [];
  interface Waiter {
    predicate: (event: TransportEvent<TInput, TOutput>) => boolean;
    resolve: (index: number) => void;
  }
  const waiters: Waiter[] = [];

  const unsubscribe = source.subscribe((event) => {
    events.push(event);
    const index = events.length - 1;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter?.predicate(event)) {
        waiters.splice(i, 1);
        waiter.resolve(index);
      }
    }
  });

  const matchIndex = async (predicate: (event: TransportEvent<TInput, TOutput>) => boolean): Promise<number> => {
    const buffered = events.findIndex((event) => predicate(event));
    if (buffered !== -1) return buffered;
    return new Promise<number>((resolve) => {
      waiters.push({ predicate, resolve });
    });
  };

  return {
    events,
    next: async (predicate) => {
      const index = await matchIndex(predicate);
      const event = events[index];
      if (!event) throw new Error('recorder index out of range');
      return event;
    },
    until: async (predicate) => {
      const index = await matchIndex(predicate);
      return events.slice(0, index + 1);
    },
    stop: unsubscribe,
  };
};

/**
 * Predicate: a run-lifecycle event of the given type for the given run.
 * @param type - The lifecycle arm to match.
 * @param runId - The run the test owns.
 * @returns The predicate.
 */
export const isRunLifecycle =
  <TInput, TOutput>(type: RunLifecycleEvent['type'], runId: string) =>
  (event: TransportEvent<TInput, TOutput>): boolean =>
    event.kind === 'run-lifecycle' && event.event.type === type && event.event.runId === runId;

/**
 * Predicate: a step-lifecycle event of the given type for the given run.
 * @param type - The lifecycle arm to match.
 * @param runId - The run the test owns.
 * @returns The predicate.
 */
export const isStepLifecycle =
  <TInput, TOutput>(type: StepLifecycleEvent['type'], runId: string) =>
  (event: TransportEvent<TInput, TOutput>): boolean =>
    event.kind === 'step-lifecycle' && event.event.type === type && event.event.runId === runId;

/**
 * Predicate: a message event carrying at least one decoded input for the
 * given transport-message-id (a wire echo, not the optimistic local echo — the
 * wire echo carries a serial).
 * @param transportMessageId - The published input's transport-message-id.
 * @returns The predicate.
 */
export const isInputFor =
  <TInput, TOutput>(transportMessageId: string) =>
  (event: TransportEvent<TInput, TOutput>): boolean =>
    event.kind === 'message' &&
    event.meta.transportMessageId === transportMessageId &&
    event.inputs.length > 0 &&
    event.meta.serial !== undefined;

/**
 * The decoded outputs across a slice of events, in arrival order.
 * @param events - The events to project.
 * @returns The outputs, flattened.
 */
export const outputsOf = <TInput, TOutput>(events: TransportEvent<TInput, TOutput>[]): TOutput[] =>
  events.flatMap((event) => (event.kind === 'message' ? event.outputs : []));

/**
 * A compact per-event label for whole-sequence shape assertions:
 * `run:start`, `step:step-end`, or `message[<direction:type> ...]` listing the
 * event's decoded contents (`message[]` for a metadata-only message event).
 * @param event - The event to label.
 * @returns The label.
 */
export const eventShape = <TInput extends { kind: string }, TOutput extends { type: string }>(
  event: TransportEvent<TInput, TOutput>,
): string => {
  if (event.kind === 'run-lifecycle') return `run:${event.event.type}`;
  if (event.kind === 'step-lifecycle') return `step:${event.event.type}`;
  const parts = [...event.inputs.map((i) => `in:${i.kind}`), ...event.outputs.map((o) => `out:${o.type}`)];
  return `message[${parts.join(' ')}]`;
};
