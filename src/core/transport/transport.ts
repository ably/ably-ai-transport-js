/**
 * The transport: one Ably channel and one codec.
 *
 * `send` publishes one event as the messages its codec encodes it to. `pipe`
 * reads a source of events and writes each one as a publish, append or update,
 * with its own key table for the streams the codec names. Neither needs the
 * channel attached, and both take `headers`, a flat map added to every
 * message the call publishes so a subscriber can tell one call's messages
 * from another's.
 *
 * `subscribe` is the receive side. The first call registers the transport's
 * channel listener and then attaches, so no message can arrive with nothing to
 * receive it. Every inbound message goes through the codec and is delivered:
 * one delivery per event the codec decodes from it, and one with
 * `event: undefined` when the codec has nothing for it (a foreign message, a
 * replay the codec's version guard dropped, a `message.delete`) or its decode
 * threw, so the application always sees the raw message and decides for
 * itself. A channel state change
 * that breaks continuity is reported as a discontinuity; the application
 * recovers by reading `history` back to the last serial it applied.
 *
 * `history` opens a walk backwards from the attach point through the same
 * codec, so a message that history and live delivery both carry decodes once.
 *
 * `close` stops every pipe in flight, unsubscribes the listener and settles.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { Codec, Delivery } from '../codec/codec.js';
import { closedError, ContinuityWatcher, subscribeAndAttach, wrapMessageProcessingError } from './channel-support.js';
import { type MessageHeaders, prepareHeaders, withHeaders } from './headers.js';
import { type HistoryOptions, type HistoryPage, openHistoryWalk } from './history-pager.js';
import { type PipeResult, type PipeSource, pipeStream } from './pipe-stream.js';
import { createPipeWriter } from './pipe-writer.js';

/**
 * Options for {@link createTransport}.
 * @template E - The codec's event union.
 */
export interface TransportOptions<E> {
  /** The channel to publish on and receive from. The caller resolves and owns it; the transport never detaches it. */
  channel: Ably.RealtimeChannel;
  /** The codec that turns events into Ably messages and back. */
  codec: Codec<E>;
  /** Logger for diagnostics. Silent when omitted. */
  logger?: Logger;
}

/** The result of {@link Transport.send}. */
export interface SendResult {
  /** The ack serial of the last message published for the event, or `undefined` when the codec published nothing for it. */
  serial: string | undefined;
}

/** Options for {@link Transport.send}. */
export interface SendOptions {
  /**
   * Headers for every message the call publishes, under `extras.headers`, the
   * key Ably provides for a publisher's own fields. Where the codec's row sets
   * the same key, the row's value is preferred, so a row keeps a header it
   * writes. The merged map reaches the row's `decode` in its `headers`, since
   * the wire cannot tell a caller's headers from a row's; the shipped Vercel
   * and OpenAI codecs write no headers and rebuild their events from the
   * message body and `extras.ai.fields`, so a decoded provider event carries
   * none of these. An `undefined` value is dropped; any other value
   * outside string, number, boolean and null rejects the call with
   * `InvalidArgument` before anything is published. A subscriber reads them
   * off `delivery.message.extras.headers`.
   */
  headers?: MessageHeaders;
}

/** Options for {@link Transport.pipe}. */
export interface PipeOptions {
  /** Fires to cancel the pipe. The pipe stops reading at the next event boundary, flushes what it has written, and rejects `OperationCancelled`. */
  signal?: AbortSignal;
  /**
   * Headers for every message the pipe publishes: the publish that opens a
   * stream, each append, each update, the repair of a failed append and the
   * message that ends a stream. Ably keeps the last write's `extras` on an
   * appended message, so a header on every write is what keeps it on the
   * stored message. Merged and checked as {@link SendOptions.headers}; a
   * rejected pipe has not touched its source. They ride on every append, so
   * keep them small.
   */
  headers?: MessageHeaders;
}

/**
 * The transport over one channel and one codec.
 * @template E - The codec's event union.
 */
export interface Transport<E> {
  /**
   * Encode one event and publish the messages it encodes to, in order.
   * Resolves with the ack serial of the last one, or `undefined` when the
   * codec published nothing. Publishing stops at the first failure, which is
   * the rejection; the messages published before it stay on the channel, so a
   * codec that splits an event should make each piece decodable on its own. A
   * `publish` key on an encoded message is a one-off here: nothing is
   * remembered for a later append.
   * @param event - The event to publish.
   * @param options - The call's headers.
   * @returns The ack serial of the last publish, or `undefined` when the codec published nothing.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when a header value is not a string, number, boolean or null, or when any of the event's messages appends or updates, since `send` has no key table (nothing is published either way); `InsufficientCapability` when the channel rejects a publish for a capability reason; `SessionSendFailed` for any other publish failure; `SessionClosed` after `close()`.
   */
  send(event: E, options?: SendOptions): Promise<SendResult>;
  /**
   * Read a source of events and write each one as the codec directs. Resolves
   * when the source ends, with the ack serial of the last publish. Rejects with
   * `OperationCancelled` when `signal` fires or the transport closes, and with
   * `PipeFailed` when the source throws, the codec cannot encode an event, a
   * publish or update fails, or a stream's repair fails; the underlying failure
   * is the `cause`. Before it settles either way the pipe flushes and repairs
   * what it wrote, so a cancelled pipe leaves whole messages behind.
   * @param source - The events to write, a ReadableStream or an async iterable.
   * @param options - The pipe's abort signal and the call's headers.
   * @returns The serial of the last publish; see {@link PipeResult}.
   * @throws {Ably.ErrorInfo} `SessionClosed` when called after `close()`; `InvalidArgument` when a header value is not a string, number, boolean or null, before the source is touched; `OperationCancelled` when cancelled; `PipeFailed` when the pipe could not finish.
   */
  pipe(source: PipeSource<E>, options?: PipeOptions): Promise<PipeResult>;
  /**
   * Deliver every message on the channel to `handler`: one delivery per event
   * the codec decodes from it, and one with `event: undefined` when the codec
   * has nothing for it (a foreign message, a replay, a `message.delete`) or
   * its decode threw.
   * The first call registers the channel listener and attaches; a failed
   * attach is reported on `on('error')` and the next call retries it. Any
   * number of handlers may subscribe, and a handler that throws is logged and
   * does not stop the others.
   * @param handler - Called with each delivery, in channel order.
   * @returns The unsubscribe: stops delivering to this handler. The channel listener stays registered for the transport's other handlers until `close()`.
   * @throws {Ably.ErrorInfo} `SessionClosed` after `close()`.
   */
  subscribe(handler: (delivery: Delivery<E>) => void): () => void;
  /**
   * Read channel history backwards from the attach point, decoded through the
   * codec. Each call starts a new walk at the channel's current attach point
   * and resolves with its newest page; the older pages follow through the
   * page's `next()`. The channel is attached if nothing has yet. A message
   * both history and live delivery carry decodes once, so a message a
   * subscriber already received comes back with no event.
   * @param options - The page size.
   * @returns The newest page, oldest first within it, leading to the older pages.
   * @throws {Ably.ErrorInfo} `SessionHistoryFetchFailed` when the page cannot be fetched after retries; `SessionClosed` after `close()`.
   */
  history(options: HistoryOptions): Promise<HistoryPage<E>>;
  /**
   * Listen for a discontinuity, a channel state change after which messages
   * may have been missed: FAILED, SUSPENDED, DETACHED, or ATTACHED with
   * `resumed: false`. Streams in flight heal on their own through the
   * full-content update that follows. To recover the rest, the application
   * pages `history()` back to the last serial it applied and applies what it
   * has not seen; the codec returns a message the handler already saw with no
   * event.
   * @param event - The event name.
   * @param handler - Called on each discontinuity, with nothing.
   * @returns The unsubscribe.
   */
  on(event: 'discontinuity', handler: () => void): () => void;
  /**
   * Listen for failures with no caller to reject: a codec `decode` that threw,
   * a failed attach, a history page that could not be decoded.
   * @param event - The event name.
   * @param handler - Called with each error.
   * @returns The unsubscribe.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;
  /**
   * Stop every pipe in flight (each flushes and repairs what it wrote, then
   * rejects `OperationCancelled` to its caller), unsubscribe the channel
   * listener and settle. Never rejects. Later calls on the transport throw
   * `SessionClosed`. Idempotent.
   */
  close(): Promise<void>;
}

interface InFlightPipe {
  controller: AbortController;
  done: Promise<unknown>;
}

interface TransportEvents<E> {
  delivery: Delivery<E>;
  discontinuity: undefined;
  error: Ably.ErrorInfo;
}

/**
 * Wrap a publish failure. A capability rejection gets its own code so an
 * application can tell a missing channel capability from a transient failure.
 * @param error - The thrown value.
 * @returns The wrapped error.
 */
const wrapPublishError = (error: unknown): Ably.ErrorInfo => {
  const cause = errorCause(error);
  const isPermission = cause?.statusCode === 401 || cause?.statusCode === 403;
  return new Ably.ErrorInfo(
    isPermission
      ? 'unable to publish; missing publish capability on the channel'
      : `unable to publish; ${errorMessage(error)}`,
    isPermission ? ErrorCode.InsufficientCapability : ErrorCode.SessionSendFailed,
    isPermission ? 401 : 500,
    cause,
  );
};

class DefaultTransport<E> implements Transport<E> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<E>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<TransportEvents<E>>;
  private readonly _pipes = new Set<InFlightPipe>();
  /** The channel listener, one bound reference so `close()` unsubscribes the same one. */
  private readonly _listener: (message: Ably.InboundMessage) => void;
  private readonly _continuity: ContinuityWatcher;
  /** Whether the channel listener is registered and the attach is in flight or done. Cleared when the attach fails, so the next `subscribe` retries. */
  private _attached = false;
  private _closed = false;

  constructor(options: TransportOptions<E>) {
    this._channel = options.channel;
    this._codec = options.codec;
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'Transport',
    });
    this._emitter = new EventEmitter<TransportEvents<E>>(this._logger);
    this._listener = (message: Ably.InboundMessage) => {
      if (!this._closed) this._deliverNow(message);
    };
    this._continuity = new ContinuityWatcher(this._channel, (stateChange) => {
      this._logger.warn('Transport; channel continuity lost', {
        current: stateChange.current,
        resumed: stateChange.resumed,
      });
      this._emitter.emit('discontinuity');
    });
  }

  async send(event: E, options?: SendOptions): Promise<SendResult> {
    this._logger.trace('Transport.send();', { headers: Object.keys(options?.headers ?? {}) });
    if (this._closed) throw closedError('send');
    const headers = prepareHeaders(options?.headers, 'send');
    const encoded = this._codec.encode(event);
    // Checked before the first publish, so an event that mixes a publish with
    // an append writes nothing.
    if (encoded.some((m) => m.append !== undefined || m.update !== undefined)) {
      throw new Ably.ErrorInfo(
        'unable to send; the event appends to or updates a stream, which needs a pipe',
        ErrorCode.InvalidArgument,
        400,
      );
    }
    let serial: string | undefined;
    for (const { message } of encoded) {
      serial = await this._publish(headers === undefined ? message : withHeaders(message, headers));
    }
    this._logger.debug('Transport.send(); published', { serial, messages: encoded.length });
    return { serial };
  }

  /**
   * Publish one message and return its ack serial.
   * @param message - The message.
   * @returns The ack serial.
   * @throws {Ably.ErrorInfo} `InsufficientCapability` or `SessionSendFailed` when the publish fails; `InternalError` when the ack carries no serial.
   */
  private async _publish(message: Ably.Message): Promise<string> {
    let result: Ably.PublishResult;
    try {
      result = await this._channel.publish(message);
    } catch (error) {
      const wrapped = wrapPublishError(error);
      this._logger.error('Transport.send(); publish failed', { error: wrapped.message });
      throw wrapped;
    }
    const serial = result.serials[0] ?? undefined;
    if (serial === undefined) {
      throw new Ably.ErrorInfo('unable to send; no serial returned', ErrorCode.InternalError, 500);
    }
    return serial;
  }

  async pipe(source: PipeSource<E>, options?: PipeOptions): Promise<PipeResult> {
    this._logger.trace('Transport.pipe();', { headers: Object.keys(options?.headers ?? {}) });
    if (this._closed) throw closedError('pipe');
    // Checked before the source is read, so a rejected pipe has locked no
    // stream and called no iterator's return().
    const headers = prepareHeaders(options?.headers, 'pipe');
    const controller = new AbortController();
    // The pipe stops on the caller's signal or on close(), whichever fires first.
    const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const writer = createPipeWriter(this._channel, this._logger);
    const done = pipeStream(source, this._codec, writer, { signal, headers, logger: this._logger });
    const inFlight: InFlightPipe = { controller, done };
    this._pipes.add(inFlight);
    try {
      return await done;
    } finally {
      this._pipes.delete(inFlight);
    }
  }

  subscribe(handler: (delivery: Delivery<E>) => void): () => void {
    this._logger.trace('Transport.subscribe();');
    if (this._closed) throw closedError('subscribe');
    this._emitter.on('delivery', handler);
    this._attach();
    return () => {
      this._emitter.off('delivery', handler);
    };
  }

  async history(options: HistoryOptions): Promise<HistoryPage<E>> {
    this._logger.trace('Transport.history();', { limit: options.limit });
    if (this._closed) throw closedError('history');
    return openHistoryWalk({
      channel: this._channel,
      limit: options.limit,
      toDeliveries: (message) => this._toDeliveries(message),
      logger: this._logger,
    });
  }

  on(event: 'discontinuity', handler: () => void): () => void;
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;
  on<K extends 'discontinuity' | 'error'>(event: K, handler: (arg: TransportEvents<E>[K]) => void): () => void {
    this._emitter.on(event, handler);
    return () => {
      this._emitter.off(event, handler);
    };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._logger.info('Transport.close();');
    this._closed = true;
    this._continuity.dispose();
    this._channel.unsubscribe(this._listener);
    this._emitter.off();
    for (const pipe of this._pipes) pipe.controller.abort();
    // Each pipe rejects OperationCancelled to its own caller once it has
    // flushed and repaired; allSettled waits for that without rethrowing it here.
    await Promise.allSettled([...this._pipes].map(async (pipe) => pipe.done));
  }

  /**
   * Register the channel listener and attach, once. A failed attach is reported
   * on the error stream and forgotten, so the next `subscribe` retries against
   * a channel that may have recovered.
   */
  private _attach(): void {
    if (this._attached) return;
    this._attached = true;
    const attempt = subscribeAndAttach(this._channel, this._listener, this._logger, 'Transport', (error) => {
      this._emitter.emit('error', error);
    });
    // The failure has already reached the error stream through the callback
    // above; this catch only clears the memo, and keeps the rejection handled.
    attempt.catch(() => {
      this._attached = false;
    });
  }

  private _deliverNow(message: Ably.InboundMessage): void {
    for (const delivery of this._toDeliveries(message)) this._emitter.emit('delivery', delivery);
  }

  /**
   * Decode one message into its deliveries. Every message is delivered: one
   * delivery per event the codec decodes from it, and one with
   * `event: undefined` when the codec has nothing for it (a foreign message, a
   * replay its version guard dropped, a delete) or its decode threw, so the
   * application always sees the raw message.
   * @param message - The inbound message.
   * @returns The deliveries, in order.
   */
  private _toDeliveries(message: Ably.InboundMessage): Delivery<E>[] {
    this._logger.trace('Transport; inbound message', { serial: message.serial, action: message.action });
    let events: E[] = [];
    try {
      events = this._codec.decode(message);
    } catch (error) {
      const wrapped = wrapMessageProcessingError(error);
      this._logger.error('Transport; decode failed, delivering the message without an event', {
        serial: message.serial,
        error: wrapped.message,
      });
      this._emitter.emit('error', wrapped);
    }
    return events.length === 0 ? [{ event: undefined, message }] : events.map((event) => ({ event, message }));
  }
}

/**
 * Create a transport over a channel and a codec.
 * @param options - See {@link TransportOptions}.
 * @returns The transport.
 */
export const createTransport = <E>(options: TransportOptions<E>): Transport<E> => new DefaultTransport(options);
