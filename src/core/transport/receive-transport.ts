/**
 * The receive side of the transport: classification plus the public event
 * stream.
 *
 * {@link classifyWireMessage} is the one place that turns a raw inbound Ably
 * message into a typed {@link TransportEvent} — run-lifecycle, step-lifecycle,
 * or a codec-decoded message — reusing the header parsers and the codec
 * decoder. The public {@link TransportReceiver} is built on it, so every
 * consumer sees one classification of the wire.
 *
 * {@link createReceiveTransport} wraps the classifier in an event emitter a
 * developer subscribes to directly: it emits the typed `event` before the raw
 * `ably-message`, and turns a decode failure into an `error` that drops the one
 * message rather than tearing down the stream.
 */

import type * as Ably from 'ably';

import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getTransportHeaders } from '../../utils.js';
import type { Decoder } from '../codec/types.js';
import { wrapMessageProcessingError } from './channel-support.js';
import { isRunLifecycleName, isStepLifecycleName, parseRunLifecycle, parseStepLifecycle } from './headers.js';
import type { TransportEvent, TransportReceiver } from './types/transport.js';
import { wireMetaFromMessage } from './wire-meta.js';

/**
 * Classify one inbound wire message into a typed {@link TransportEvent}, reusing
 * the header parsers and the codec decoder.
 *
 * Run-lifecycle names parse via {@link parseRunLifecycle}; step-lifecycle names
 * via {@link parseStepLifecycle}; everything else is decoded by the bound
 * decoder. A codec-decoded message that yields no events and carries no run-id
 * is a wire-only carrier and returns `undefined` (filtered), matching the live
 * merge. A lifecycle name whose message is missing the identifiers its parser
 * needs also returns `undefined`. The decoder may throw on a malformed payload;
 * the throw propagates to the caller, which decides whether to drop or surface
 * it.
 * @param decoder - The codec decoder used for non-lifecycle messages.
 * @param rawMsg - The inbound Ably wire message.
 * @returns The classified event, or `undefined` for a filtered / unparseable message.
 */
export const classifyWireMessage = <TInput, TOutput>(
  decoder: Decoder<TInput, TOutput>,
  rawMsg: Ably.InboundMessage,
): TransportEvent<TInput, TOutput> | undefined => {
  const serial = rawMsg.serial;
  // Top-level timestamp — the message's create time on every delivery (an
  // append's own receive time lives in `version.timestamp`).
  const timestamp = rawMsg.timestamp;

  if (isRunLifecycleName(rawMsg.name)) {
    const headers = getTransportHeaders(rawMsg);
    const event = parseRunLifecycle(rawMsg.name, headers, serial, timestamp);
    return event ? { kind: 'run-lifecycle', event } : undefined;
  }

  if (isStepLifecycleName(rawMsg.name)) {
    const headers = getTransportHeaders(rawMsg);
    const event = parseStepLifecycle(rawMsg.name, headers, serial, timestamp);
    return event ? { kind: 'step-lifecycle', event } : undefined;
  }

  const { inputs, outputs } = decoder.decode(rawMsg);
  const meta = wireMetaFromMessage(rawMsg);
  // A wire-only carrier (no decoded events, no run-id) is filtered — consumers
  // never see wire noise. Truthiness, not a defined-check: an empty-string
  // run-id is as absent as a missing header.
  if (inputs.length === 0 && outputs.length === 0 && !meta.runId) return undefined;
  return { kind: 'message', meta, inputs, outputs };
};

/**
 * The outcome of feeding one inbound wire message to
 * {@link ReceiveTransport.deliverEvent}. Distinguishes a filtered message
 * (wire-only noise, legitimately dropped) from a failed one (the decoder
 * threw), so the owner can skip its own follow-on side-effects for a message
 * the merge never applied while still running them for a filtered one.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export type DeliverEventResult<TInput, TOutput> =
  | {
      /** The message classified; its `event` was emitted to subscribers. */
      outcome: 'classified';
      /** The classified transport event. */
      event: TransportEvent<TInput, TOutput>;
    }
  | {
      /** The message was wire-only noise or an unparseable lifecycle; nothing was emitted. */
      outcome: 'filtered';
    }
  | {
      /** The decoder threw; the message was dropped and an `error` was emitted. */
      outcome: 'failed';
    };

/**
 * The public {@link TransportReceiver} plus the driving methods its owner calls.
 * The owner (a transport, or a standalone consumer) feeds inbound messages
 * in; subscribers observe the classified events out.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface ReceiveTransport<TInput, TOutput> extends TransportReceiver<TInput, TOutput> {
  /**
   * Classify one inbound wire message and emit its typed `event`. A decode
   * failure emits `error`, drops the message, and reports `failed` so the
   * owner can skip follow-on processing of a message the merge never took.
   * Does NOT emit `ably-message` — the owner calls {@link deliverAblyMessage}
   * so batch (history) and live paths control the raw emit independently.
   * @param rawMsg - The inbound Ably wire message.
   * @returns The delivery outcome; see {@link DeliverEventResult}.
   */
  deliverEvent(rawMsg: Ably.InboundMessage): DeliverEventResult<TInput, TOutput>;
  /**
   * Emit a synthesized `event` that has no backing inbound wire message — the
   * agent writer's optimistic step-lifecycle seed. Delivered to `event`
   * subscribers synchronously and in registration order, exactly like a
   * classified wire event; a consumer reconciles it against the later wire
   * bracket by `stepStartSerial`. Emits no `ably-message`; there is no raw
   * message.
   * @param event - The pre-built local event to emit.
   */
  emitEvent(event: TransportEvent<TInput, TOutput>): void;
  /**
   * Emit the raw `ably-message`, after its typed `event` so a handler sees any
   * state an earlier subscriber merged.
   * @param rawMsg - The inbound Ably wire message.
   */
  deliverAblyMessage(rawMsg: Ably.InboundMessage): void;
  /**
   * Emit an `error` to subscribers — for a channel/subscription failure the
   * owner catches outside the classify path.
   * @param err - The error to surface.
   */
  emitError(err: Ably.ErrorInfo): void;
}

/** Event map for the receiver's typed emitter. */
interface ReceiveEventsMap<TInput, TOutput> {
  /** A classified transport event. */
  event: TransportEvent<TInput, TOutput>;
  /** A raw inbound Ably message. */
  'ably-message': Ably.InboundMessage;
  /** A receive-stream error. */
  error: Ably.ErrorInfo;
}

/** Default {@link ReceiveTransport} backed by the typed {@link EventEmitter}. */
class DefaultReceiveTransport<TInput, TOutput> implements ReceiveTransport<TInput, TOutput> {
  private readonly _decoder: Decoder<TInput, TOutput>;
  private readonly _emitter: EventEmitter<ReceiveEventsMap<TInput, TOutput>>;
  private readonly _logger: Logger;

  constructor(decoder: Decoder<TInput, TOutput>, logger: Logger) {
    this._decoder = decoder;
    this._logger = logger.withContext({ component: 'ReceiveTransport' });
    this._emitter = new EventEmitter<ReceiveEventsMap<TInput, TOutput>>(this._logger);
  }

  on(event: 'event', handler: (e: TransportEvent<TInput, TOutput>) => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'error', handler: (err: Ably.ErrorInfo) => void): () => void;
  on<K extends keyof ReceiveEventsMap<TInput, TOutput>>(
    event: K,
    handler: (arg: ReceiveEventsMap<TInput, TOutput>[K]) => void,
  ): () => void {
    this._emitter.on(event, handler);
    return () => {
      this._emitter.off(event, handler);
    };
  }

  deliverEvent(rawMsg: Ably.InboundMessage): DeliverEventResult<TInput, TOutput> {
    let event: TransportEvent<TInput, TOutput> | undefined;
    try {
      event = classifyWireMessage(this._decoder, rawMsg);
    } catch (error) {
      const err = wrapMessageProcessingError(error);
      this._logger.error('ReceiveTransport.deliverEvent(); decode failed', { serial: rawMsg.serial, code: err.code });
      this._emitter.emit('error', err);
      return { outcome: 'failed' };
    }
    if (!event) return { outcome: 'filtered' };
    this._emitter.emit('event', event);
    return { outcome: 'classified', event };
  }

  emitEvent(event: TransportEvent<TInput, TOutput>): void {
    this._emitter.emit('event', event);
  }

  deliverAblyMessage(rawMsg: Ably.InboundMessage): void {
    this._emitter.emit('ably-message', rawMsg);
  }

  emitError(err: Ably.ErrorInfo): void {
    this._emitter.emit('error', err);
  }
}

/**
 * Create a {@link ReceiveTransport} over one codec decoder. The decoder must be
 * unique to this receiver so its stream-tracker state cannot leak across
 * consumers — one decoder per receive stream.
 * @param decoder - The codec decoder to classify non-lifecycle messages with.
 * @param logger - Logger for diagnostics.
 * @returns The receive transport.
 */
export const createReceiveTransport = <TInput, TOutput>(
  decoder: Decoder<TInput, TOutput>,
  logger: Logger,
): ReceiveTransport<TInput, TOutput> => new DefaultReceiveTransport(decoder, logger);

/**
 * Build a `TransportReceiver.on` that forwards to `receiver` — the one place
 * the overload-dispatch switch lives, shared by both transports' public `on`.
 * @param receiver - The receiver to forward subscriptions to.
 * @returns The forwarding `on`, carrying the receiver's own overloads.
 */
export const forwardReceiverOn = <TInput, TOutput>(
  receiver: TransportReceiver<TInput, TOutput>,
): TransportReceiver<TInput, TOutput>['on'] => receiver.on.bind(receiver);
