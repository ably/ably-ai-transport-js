/**
 * Type-safe EventEmitter wrapping Ably's internal EventEmitter.
 *
 * Takes a single `EventsMap` type parameter — an interface mapping event names
 * to payload types — rather than Ably's three type parameters. Adapted from
 * the ably-chat-js SDK.
 *
 * ```ts
 * interface MyEvents {
 *   reaction: { emoji: string };
 *   status: { online: boolean };
 * }
 *
 * const emitter = new EventEmitter<MyEvents>(logger);
 * emitter.on('reaction', (event) => console.log(event.emoji));
 * emitter.emit('reaction', { emoji: '👍' });
 * ```
 */

import * as Ably from 'ably';

import type { Logger } from './logger.js';

/** Callback receiving a union of all possible event payloads. */
type Callback<EventsMap> = (arg: EventsMap[keyof EventsMap]) => void;

/** Callback receiving the payload for a single event type. */
type CallbackSingle<K> = (arg: K) => void;

/**
 * Type-safe interface for the Ably EventEmitter, parameterized by an EventsMap
 * that maps event names to their payload types.
 */
interface InterfaceEventEmitter<EventsMap> extends Ably.EventEmitter<Callback<EventsMap>, void, keyof EventsMap> {
  /** Emit an event with a type-safe payload. Payload is optional for `undefined`-typed events. */
  emit<K extends keyof EventsMap>(
    event: K,
    ...args: EventsMap[K] extends undefined ? [EventsMap[K]?] : [EventsMap[K]]
  ): void;

  /** Subscribe to a single event with a typed callback. */
  on<K extends keyof EventsMap>(event: K, callback: CallbackSingle<EventsMap[K]>): void;
  /** Subscribe to two events with a union-typed callback. */
  on<K1 extends keyof EventsMap, K2 extends keyof EventsMap>(
    events: [K1, K2],
    callback: CallbackSingle<EventsMap[K1] | EventsMap[K2]>,
  ): void;
  /** Subscribe to three events with a union-typed callback. */
  on<K1 extends keyof EventsMap, K2 extends keyof EventsMap, K3 extends keyof EventsMap>(
    events: [K1, K2, K3],
    callback: CallbackSingle<EventsMap[K1] | EventsMap[K2] | EventsMap[K3]>,
  ): void;
  /** Subscribe to an array of events. */
  on(events: (keyof EventsMap)[], callback: Callback<EventsMap>): void;
  /** Subscribe to all events. */
  on(callback: Callback<EventsMap>): void;

  /** Unsubscribe a callback from a specific event. */
  off<K extends keyof EventsMap>(event: K, listener: CallbackSingle<EventsMap[K]>): void;
  /** Unsubscribe a callback from all events, or remove all listeners if no callback provided. */
  off(listener?: Callback<EventsMap>): void;
}

/**
 * Bridge from our {@link Logger} to the Ably EventEmitter's internal logger
 * contract. Ably's EventEmitter calls `logger.logAction(level, action, message)`
 * when a listener throws — we route that to our Logger's `error` method.
 * @param logger - The application logger to delegate to.
 * @returns An object satisfying the Ably EventEmitter's logger interface.
 */
const toAblyLogger = (logger: Logger): unknown => ({
  logAction: (_level: number, action: string, message?: string) => {
    logger.error(action, { detail: message });
  },
  shouldLog: () => true,
});

// CAST: Access Ably's internal EventEmitter constructor. Not publicly exported
// but available to other Ably SDKs. The logger parameter ensures listener
// exceptions are caught and logged rather than crashing.
const InternalEventEmitter: new <EventsMap>(logger: unknown) => InterfaceEventEmitter<EventsMap> = (
  Ably.Realtime as unknown as { EventEmitter: new <EventsMap>(logger: unknown) => InterfaceEventEmitter<EventsMap> }
).EventEmitter;

/**
 * Type-safe EventEmitter based on Ably's internal EventEmitter.
 *
 * Provides the same semantics as {@link Ably.EventEmitter} (error isolation
 * between listeners, synchronous dispatch) but with a single `EventsMap` type
 * parameter for ergonomic type safety.
 *
 * Requires a {@link Logger} so that listener exceptions are routed through
 * the application's logging infrastructure rather than silently swallowed.
 */
export class EventEmitter<EventsMap> extends InternalEventEmitter<EventsMap> {
  /**
   * Create a new EventEmitter.
   * @param logger - Application logger. Listener exceptions are logged at error level.
   */
  constructor(logger: Logger) {
    super(toAblyLogger(logger));
  }
}
