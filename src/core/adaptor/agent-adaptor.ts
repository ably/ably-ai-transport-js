/**
 * The agent adaptor: the publish side of the SDK, over a channel the
 * application got from ably-js.
 *
 * An adaptor knows one codec and one channel. `send` publishes one discrete
 * event, such as the user's message. `pipe` writes a stream of events
 * unattended and resolves once the stream is on the channel. `pipeEach` writes
 * the same stream and hands each event back once it is written, so the agent
 * can act inside the loop and set its pace.
 *
 * Each pipe call gets its own writer, since its key table, pending appends and
 * repair state belong to one stream of events. `send` needs no writer: it
 * publishes, and refuses an event that appends or updates. Every message
 * carries the call's headers over the adaptor's default headers, with a codec
 * row's own headers winning over both.
 *
 * The adaptor holds no resource of its own, so it has no `close`. A pipe stops
 * on its signal, and `pipeEach` also when the loop leaves early.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { Codec } from '../codec/codec.js';
import { assertCodecWrote } from './codec-fields.js';
import { mergeHeaders, type MessageHeaders, prepareHeaders, withHeaders } from './headers.js';
import {
  pipeEach as pipeEachDriver,
  type PipeResult,
  type PipeSource,
  pipeStream,
  type Published,
} from './pipe-stream.js';
import { type ChannelWriter, createPipeWriter } from './pipe-writer.js';

/** Options for an agent adaptor factory. */
export interface AgentAdaptorOptions {
  /** Logger for the adaptor's diagnostics: repairs, failed acks, cancelled pipes. Silent when omitted. */
  logger?: Logger;
  /**
   * Headers for every message the adaptor publishes, under `extras.headers`.
   * A call's headers win over these where both name a key, and a codec row's
   * own headers win over both. Checked as {@link SendOptions.headers}, when
   * the adaptor is created.
   */
  headers?: MessageHeaders;
}

/** The result of {@link AgentAdaptor.send}. */
export interface SendResult {
  /** The ack serial of the last message published for the event, or `undefined` when the codec published nothing for it. */
  serial: string | undefined;
}

/** Options for {@link AgentAdaptor.send}. */
export interface SendOptions {
  /**
   * Headers for every message the call publishes, under `extras.headers`, the
   * key Ably provides for a publisher's own fields. They win over the
   * adaptor's default headers where both name a key, and a codec row's own
   * headers win over them. The merged map reaches the row's `decode` in its
   * `headers`, since the wire cannot tell a caller's headers from a row's;
   * the shipped codecs write no headers and rebuild their events from the
   * message body and `extras.ai.fields`, so a decoded provider event carries
   * none of these. An `undefined` value is dropped; any other value outside
   * string, number, boolean and null rejects the call with `InvalidArgument`
   * before anything is published. A subscriber reads them off
   * `delivery.message.extras.headers`.
   */
  headers?: MessageHeaders;
}

/** Options for {@link AgentAdaptor.pipe} and {@link AgentAdaptor.pipeEach}. */
export interface PipeOptions {
  /** Fires to cancel the pipe. The pipe stops reading at the next event boundary. */
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
 * Publishes one provider's events on one channel, through its codec.
 * @template E - The codec's event union.
 */
export interface AgentAdaptor<E> {
  /**
   * Encode one event and publish the messages it encodes to, in order.
   * Resolves with the ack serial of the last one, or `undefined` when the
   * codec published nothing. Publishing stops at the first failure, which is
   * the rejection; the messages published before it stay on the channel. A
   * `publish` key on an encoded message is a one-off here: nothing is
   * remembered for a later append.
   * @param event - The event to publish.
   * @param options - The call's headers.
   * @returns The ack serial of the last publish, or `undefined` when the codec published nothing.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when a header value is not a string, number, boolean or null, when a message the codec encoded lacks the codec's `name` or its `id` under `extras.ai.codec`, or when any of the event's messages appends or updates, since `send` has no key table (nothing is published either way); `InsufficientCapability` when the channel rejects a publish for a capability reason; `SessionSendFailed` for any other publish failure.
   */
  send(event: E, options?: SendOptions): Promise<SendResult>;
  /**
   * Read a source of events and write each one as the codec directs,
   * unattended. Resolves when the source ends, with the ack serial of the
   * last publish. Before it settles either way the pipe flushes and repairs
   * what it wrote, so a cancelled pipe leaves whole messages behind.
   * @param source - The events to write, a ReadableStream or an async iterable.
   * @param options - The pipe's abort signal and the call's headers.
   * @returns The serial of the last publish; see {@link PipeResult}.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when a header value is not a string, number, boolean or null, before the source is touched; `OperationCancelled` when the signal fires; `PipeFailed` when the source throws, the codec cannot encode an event or encodes a message without its `name` and `id`, a publish or update fails, or a stream's repair fails, with the failure as `cause`.
   */
  pipe(source: PipeSource<E>, options?: PipeOptions): Promise<PipeResult>;
  /**
   * Read a source of events, write each one as the codec directs, and hand
   * each back once it is written. Nothing is read or written until the loop
   * asks for the first event, and the next event is read only when the loop
   * body has finished with the last one.
   *
   * A publish is yielded once acked. An append to an open stream is yielded
   * at once, before its ack, so nothing caps the appends in flight: a source
   * faster than the connection queues them in ably-js. A failed append is
   * repaired before the event that ends its stream; a failed repair throws
   * from that event, which is never yielded. When the source ends, or the
   * pipe itself fails, the adaptor flushes and repairs what it wrote before
   * the loop finishes or the failure is thrown.
   *
   * Leaving the loop early (`break`, `return`, a throw in the loop body) or
   * the signal firing stops where the pipe has got to. Nothing more is
   * written, nothing is flushed or repaired, and no open stream is ended, so
   * subscribers see those streams stay open and a decoder keeps their state.
   * Leaving early does not stop the source: a `ReadableStream` is released,
   * not cancelled, so its producer (a model call, say) keeps running until
   * the caller stops it, for example by aborting the model call with the
   * same signal. Track the last serial inside the loop if it is needed after
   * it.
   * @param source - The events to write, a ReadableStream or an async iterable.
   * @param options - The pipe's abort signal and the call's headers.
   * @returns The events, each with the serial of the message it landed on.
   * @throws {Ably.ErrorInfo} `InvalidArgument`, thrown by this call itself and not from the loop, when a header value is not a string, number, boolean or null; from the loop, `OperationCancelled` when the signal fires and `PipeFailed` when the source throws, the codec cannot encode an event or encodes a message without its `name` and `id`, a publish or update fails, or a repair fails, with the failure as `cause`.
   */
  pipeEach(source: PipeSource<E>, options?: PipeOptions): AsyncIterable<Published<E>>;
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

class DefaultAgentAdaptor<E> implements AgentAdaptor<E> {
  private readonly _channel: ChannelWriter;
  private readonly _codec: Codec<E>;
  private readonly _headers: MessageHeaders | undefined;
  private readonly _logger: Logger;

  constructor(channel: ChannelWriter, codec: Codec<E>, options: AgentAdaptorOptions) {
    this._channel = channel;
    this._codec = codec;
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'AgentAdaptor',
      codec: codec.id,
    });
    this._headers = prepareHeaders(options.headers, 'create agent adaptor');
  }

  async send(event: E, options?: SendOptions): Promise<SendResult> {
    this._logger.trace('AgentAdaptor.send();', { headers: Object.keys(options?.headers ?? {}) });
    const headers = mergeHeaders(this._headers, prepareHeaders(options?.headers, 'send'));
    const encoded = this._codec.encode(event);
    // Checked before the first publish, so an event that mixes a publish with
    // an append, or carries a message the codec's decoder would skip, writes
    // nothing.
    for (const { message } of encoded) assertCodecWrote(message, this._codec, 'send');
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
    this._logger.debug('AgentAdaptor.send(); published', { serial, messages: encoded.length });
    return { serial };
  }

  async pipe(source: PipeSource<E>, options?: PipeOptions): Promise<PipeResult> {
    this._logger.trace('AgentAdaptor.pipe();', { headers: Object.keys(options?.headers ?? {}) });
    // Checked before the source is read, so a rejected pipe has locked no
    // stream and called no iterator's return().
    const headers = mergeHeaders(this._headers, prepareHeaders(options?.headers, 'pipe'));
    const writer = createPipeWriter(this._channel, this._logger);
    return pipeStream(source, this._codec, writer, { signal: options?.signal, headers, logger: this._logger });
  }

  pipeEach(source: PipeSource<E>, options?: PipeOptions): AsyncIterable<Published<E>> {
    this._logger.trace('AgentAdaptor.pipeEach();', { headers: Object.keys(options?.headers ?? {}) });
    const headers = mergeHeaders(this._headers, prepareHeaders(options?.headers, 'pipe'));
    const writer = createPipeWriter(this._channel, this._logger);
    return pipeEachDriver(source, this._codec, writer, { signal: options?.signal, headers, logger: this._logger });
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
      this._logger.error('AgentAdaptor.send(); publish failed', { error: wrapped.message });
      throw wrapped;
    }
    const serial = result.serials[0] ?? undefined;
    if (serial === undefined) {
      throw new Ably.ErrorInfo('unable to send; no serial returned', ErrorCode.InternalError, 500);
    }
    return serial;
  }
}

/**
 * Create an agent adaptor over a codec and a channel the application got from
 * ably-js. Use one of the provider factories for a shipped codec.
 * @param channel - The channel to publish on. An `Ably.RealtimeChannel` satisfies it.
 * @param codec - The codec that turns events into Ably messages.
 * @param options - See {@link AgentAdaptorOptions}.
 * @returns The adaptor.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a default header value is not a string, number, boolean or null.
 */
export const createAgentAdaptor = <E>(
  channel: ChannelWriter,
  codec: Codec<E>,
  options: AgentAdaptorOptions = {},
): AgentAdaptor<E> => new DefaultAgentAdaptor(channel, codec, options);
