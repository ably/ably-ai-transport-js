/**
 * The decoder: the subscribe side of the SDK, for an application that reads
 * the channel through ably-js itself.
 *
 * The application passes every message it receives to the decoder, live
 * through `channel.subscribe(decoder.receive)` and from history through
 * `decoder.decode(message)`. The decoder turns each one into deliveries: one
 * per event the codec decodes from it, and one with `event: undefined` when
 * the message carries none, so the application sees every message on the
 * channel, its own included, and decides for itself.
 *
 * A message is the decoder's when it carries the codec's `name` as its name
 * and the codec's `id` under `extras.ai.codec`, as the codec writes every
 * message it encodes. Anything else is handed
 * on with no event and touches no state, so a channel can carry the
 * application's own messages and a second codec's beside this one.
 *
 * The decoder holds the per-serial state the platform's append model forces on
 * a streaming reader (see the decoder core): the text handed on so far and the
 * highest version incorporated per stream, freed when the stream's closer
 * arrives. That state is why live and history go through one decoder. A
 * message that both carry then decodes once, because the version guard drops
 * the second copy; two decoders fed the two halves would each decode it.
 *
 * History pages arrive newest first. The decoder handles a closer that
 * arrives before its stream, but it does not reorder what it returns:
 * deliveries come back in the order their messages went in, and an
 * application that renders across pages orders them itself, by serial or by
 * collecting the pages first.
 *
 * Two limits come from the platform. When an append fails after later appends
 * were delivered, the agent repairs the stream with a full-content update
 * that does not extend what the decoder handed on, and the decoder delivers
 * the whole content again as a replacement. And when an application decodes
 * live messages as they arrive but applies history first, a stream in flight
 * can come out of order: if history holds the stream at a later version than
 * the first live update, history's tail is applied before that update's head.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { Codec, Delivery } from '../codec/codec.js';
import { CODEC_FIELD, readOwnExtras } from '../wire.js';
import { createDecoderCore, type DecoderCore } from './decoder-core.js';

/** Options for {@link createDecoder}. */
export interface DecoderOptions {
  /** Logger for diagnostics. Silent when omitted. */
  logger?: Logger;
}

/**
 * Decodes the messages an agent published through a codec, live and from
 * history, holding the per-serial state that makes the two agree.
 * @template E - The codec's event union.
 */
export interface Decoder<E> {
  /**
   * Decode one message and emit each delivery to the `onEvent` handlers, in
   * order. Bound to the decoder, so it can be passed straight to
   * `channel.subscribe(decoder.receive)` and later to
   * `channel.unsubscribe(decoder.receive)`. Never throws: a message that
   * cannot be decoded is emitted with no event and reported on `onError`.
   * @param message - The message as the channel delivered it.
   */
  readonly receive: (message: Ably.InboundMessage) => void;
  /**
   * Decode one message and return its deliveries, without emitting them: one
   * per event the codec decodes from it, and one with `event: undefined` when
   * it carries none (a message that is not this codec's, a delivery already
   * seen, a `message.delete`, or a decode that failed). For a history loop,
   * or a listener the application writes itself. Never throws: a decode that
   * fails is reported on `onError` and its message returned with no event.
   * @param message - The message, live or from history.
   * @returns The deliveries, in order; never empty.
   */
  decode(message: Ably.InboundMessage): Delivery<E>[];
  /**
   * Listen for the deliveries `receive` emits. A handler that throws is
   * logged and does not stop the others.
   * @param handler - Called with each delivery, to observe.
   * @returns The unsubscribe.
   */
  onEvent(handler: (delivery: Delivery<E>) => void): () => void;
  /**
   * Listen for decode failures from `receive` and `decode`. Each carries
   * `SessionMessageProcessingFailed`, with the codec's error as `cause`.
   * @param handler - Called with each error, to observe.
   * @returns The unsubscribe.
   */
  onError(handler: (error: Ably.ErrorInfo) => void): () => void;
}

interface DecoderEvents<E> {
  event: Delivery<E>;
  error: Ably.ErrorInfo;
}

/**
 * Wrap a failure thrown while decoding a message, preserving the original as
 * `cause`.
 * @param error - The thrown value.
 * @returns The wrapped error.
 */
const decodeFailed = (error: unknown): Ably.ErrorInfo =>
  new Ably.ErrorInfo(
    `unable to process channel message; ${errorMessage(error)}`,
    ErrorCode.SessionMessageProcessingFailed,
    500,
    errorCause(error),
  );

class DefaultDecoder<E> implements Decoder<E> {
  private readonly _codec: Codec<E>;
  private readonly _core: DecoderCore;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<DecoderEvents<E>>;

  constructor(codec: Codec<E>, options: DecoderOptions) {
    this._codec = codec;
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'Decoder',
      codec: codec.id,
    });
    this._core = createDecoderCore({ logger: this._logger });
    this._emitter = new EventEmitter<DecoderEvents<E>>(this._logger);
  }

  // An arrow property, so `channel.subscribe(decoder.receive)` keeps `this`.
  readonly receive = (message: Ably.InboundMessage): void => {
    for (const delivery of this.decode(message)) this._emitter.emit('event', delivery);
  };

  decode(message: Ably.InboundMessage): Delivery<E>[] {
    this._logger.trace('DefaultDecoder.decode();', { serial: message.serial, action: message.action });
    // A delete reaches the core whoever sent it, so the core forgets a stream
    // even when a bare `deleteMessage({ serial })` arrives without the name
    // and codec id. A delete never carries an event.
    if (message.action === 'message.delete') {
      this._core.prepare(message);
      return [{ event: undefined, message }];
    }
    if (!this._isOwn(message)) return [{ event: undefined, message }];
    let events: E[] = [];
    try {
      const prepared = this._core.prepare(message);
      if (prepared !== undefined) events = this._codec.decode(prepared);
    } catch (error) {
      const wrapped = decodeFailed(error);
      this._logger.error('DefaultDecoder.decode(); decode failed, delivering the message without an event', {
        serial: message.serial,
        error: wrapped.message,
      });
      this._emitter.emit('error', wrapped);
    }
    return events.length === 0 ? [{ event: undefined, message }] : events.map((event) => ({ event, message }));
  }

  onEvent(handler: (delivery: Delivery<E>) => void): () => void {
    this._emitter.on('event', handler);
    return () => {
      this._emitter.off('event', handler);
    };
  }

  onError(handler: (error: Ably.ErrorInfo) => void): () => void {
    this._emitter.on('error', handler);
    return () => {
      this._emitter.off('error', handler);
    };
  }

  /**
   * Whether this decoder's codec wrote this message: the codec's `name`, with
   * its `id` under `extras.ai.codec`.
   * @param message - The message.
   * @returns True when the message is this codec's.
   */
  private _isOwn(message: Ably.InboundMessage): boolean {
    return message.name === this._codec.name && readOwnExtras(message.extras)?.[CODEC_FIELD] === this._codec.id;
  }
}

/**
 * Create a decoder over a codec. Use one decoder per codec per channel, for
 * live delivery and history together.
 * @param codec - The codec the agent published through.
 * @param options - See {@link DecoderOptions}.
 * @returns The decoder.
 */
export const createDecoder = <E>(codec: Codec<E>, options: DecoderOptions = {}): Decoder<E> =>
  new DefaultDecoder(codec, options);
