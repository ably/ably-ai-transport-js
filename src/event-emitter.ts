/**
 * Type-safe EventEmitter wrapping the Pub/Sub EventEmitter.
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

import * as Ably from '@ably/pubsub-core';

import type { Logger } from './logger.js';

/** Callback receiving a union of all possible event payloads. */
type Callback<EventsMap> = (arg: EventsMap[keyof EventsMap]) => void;

/** Callback receiving the payload for a single event type. */
type CallbackSingle<K> = (arg: K) => void;

/**
 * Type-safe interface for the Ably EventEmitter, parameterized by an EventsMap
 * that maps event names to their payload types.
 */
interface InterfaceEventEmitter<EventsMap> {
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

  /** Subscribe to the next occurrence of a single event with a typed callback. */
  once<K extends keyof EventsMap>(event: K, callback: CallbackSingle<EventsMap[K]>): void;
  /** Subscribe to the next occurrence of any event. */
  once(callback: Callback<EventsMap>): void;
  /** Resolve on the next occurrence of a single event. */
  once(event: keyof EventsMap): Promise<void>;
  /** Resolve on the next occurrence of any event. */
  once(): Promise<void>;

  /** The listeners registered for an event, or for all events when none is given; `null` when there are none. */
  listeners(eventName?: keyof EventsMap): Callback<EventsMap>[] | null;
}

/**
 * Bridge from our {@link Logger} to the Pub/Sub EventEmitter's options. The
 * emitter catches a listener's exception so the other listeners still run,
 * and hands it to `onListenerError`; we route that to our Logger's `error`
 * method.
 * @param logger - The application logger to delegate to.
 * @returns The options for the Pub/Sub EventEmitter.
 */
const toAblyLogger = (logger: Logger): Ably.EventEmitterOptions => ({
  onListenerError: (error: unknown) => {
    logger.error('EventEmitter.emit(); listener threw', { error });
  },
});

// CAST: the Pub/Sub EventEmitter types its events as plain strings and its
// listeners as `Function`; narrow it to the EventsMap this wrapper exists for.
// Its declared overloads differ in shape from that interface (`once` declares
// no zero-argument form, though it accepts one), so the cast goes through
// `unknown`.
const InternalEventEmitter = Ably.EventEmitter as unknown as new <EventsMap>(
  options?: Ably.EventEmitterOptions,
) => InterfaceEventEmitter<EventsMap>;

/**
 * Type-safe EventEmitter based on the Pub/Sub {@link Ably.EventEmitter}.
 *
 * Provides the same semantics (error isolation between listeners, synchronous
 * dispatch) but with a single `EventsMap` type parameter for ergonomic type
 * safety.
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
