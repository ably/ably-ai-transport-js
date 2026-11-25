/**
 * The agent adaptor: the publish side of the SDK, over a channel the
 * application got from ably-js.
 *
 * An adaptor knows one codec and one channel, and holds nothing else. A
 * stream of events is written through an event writer, which `newWriter`
 * gives out: it owns the key table, the pending appends and the repair state
 * of what it writes, from its first `write` to its `close`. The adaptor's
 * other three operations are shorthand: `pipeEach` and `pipe` for common uses
 * of a writer, and `send` for one whole message, which needs none.
 *
 * - `pipeEach(source)` opens a writer, writes each event the source yields,
 *   hands it back, and flushes the writer when the loop ends or leaves early.
 * - `pipe(source)` is `pipeEach` run to its end, resolving with the serial of
 *   the last publish as `lastPublishSerial`. Everywhere else, a `serial` the
 *   adaptor returns is the message an event landed on.
 * - `send(event)` publishes one whole message, such as the user's prompt. It
 *   keeps no key table, so it refuses an event that appends to or updates a
 *   stream, checks every message before it publishes any, and reports a
 *   publish failure under its own codes.
 *
 * Every message carries the call's headers over the adaptor's default
 * headers, with a codec row's own headers winning over both.
 *
 * The adaptor holds no resource of its own, so it has no `close`. A pipe
 * flushes and repairs what its writer wrote on every exit: its source ending,
 * its signal, a failure, and for `pipeEach` the loop leaving early.
 */

import * as Ably from '@ably/pubsub-core';

import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { Codec } from '../codec/codec.js';
import { assertCodecWrote } from './codec-fields.js';
import { createCodecSink } from './codec-sink.js';
import {
  createEventWriter,
  type DefaultEventWriter,
  type EventWriter,
  type Published,
  type WriterHandoff,
} from './event-writer.js';
import { mergeHeaders, type MessageHeaders, prepareHeaders, withHeaders } from './headers.js';
import type { ChannelWriter } from './message-stream.js';
import { pipeEach as pipeEachDriver, type PipeResult, type PipeSource, pipeStream } from './pipe-stream.js';
import { createPipeWriter, type OpenStream } from './pipe-writer.js';

/** Options for an agent adaptor factory. */
export interface AgentAdaptorOptions {
  /** Logger for the adaptor's diagnostics: repairs, failed acks, cancelled pipes. Silent when omitted. */
  logger?: Logger;
  /**
   * Headers for every message the adaptor publishes, under `extras.headers`.
   * A call's headers win over these where both name a key, and a codec row's
   * own headers win over both. A call cannot remove a default: a call's key
   * with an `undefined` value is dropped, so the default stays, and a call
   * replaces it only with another value, `null` included. Checked as
   * {@link SendOptions.headers}, when the adaptor is created.
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
  /** Fires to cancel the pipe. A read in progress is abandoned at once, and no event after it is written. Both pipes then flush and repair what they wrote, and end no open stream; `pipe` rejects and `pipeEach` throws from the loop, with `OperationCancelled`, or `PipeFailed` when the repair failed. */
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

/** Options for {@link AgentAdaptor.newWriter}. */
export interface WriterOptions {
  /**
   * Headers for every message the event writer publishes, as
   * {@link PipeOptions.headers} are for a pipe. Merged and checked as
   * {@link SendOptions.headers}, when the writer is created.
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
   * @throws {Ably.ErrorInfo} `InvalidArgument` when a header value is not a string, number, boolean or null, when a message the codec encoded lacks the codec's `name` or its `id` under `extras.ai.codec`, or when any of the event's messages appends or updates, since `send` has no key table (nothing is published either way); `InsufficientCapability` when the channel rejects a publish for a capability reason; `WriteFailed` for any other publish failure; `InternalError` when a publish's ack carries no serial. Whatever the codec's `encode` throws is passed on unchanged: for a `defineCodec` codec, `InvalidArgument` for an event whose type has no row.
   */
  send(event: E, options?: SendOptions): Promise<SendResult>;
  /**
   * Read a source of events and write each one as the codec directs,
   * unattended. Resolves when the source ends, with the ack serial of the
   * last publish as `lastPublishSerial`. Before it settles either way the pipe flushes and repairs
   * what it wrote, so every message it wrote holds its full text. A stream
   * the source had not ended gets no closing message, so a subscriber sees it
   * stay open.
   * @param source - The events to write, a ReadableStream or an async iterable.
   * @param options - The pipe's abort signal and the call's headers.
   * @returns The serial of the last publish, as `lastPublishSerial`; see {@link PipeResult}.
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
   * the signal firing stops reading, and the pipe then flushes and repairs
   * what it wrote before the loop exits, as `pipe` does on its signal. No
   * open stream is ended, so subscribers see those streams stay open and a
   * decoder keeps their state. The signal throws `OperationCancelled`, or
   * `PipeFailed` when the repair fails. A repair that fails after a `break` or
   * a `return` throws `PipeFailed` from the loop's exit; after a throw in the
   * loop body, that throw is the error and the repair failure is logged.
   * Leaving early does not stop the source: a `ReadableStream` is released,
   * not cancelled, so its producer (a model call, say) keeps running until
   * the caller stops it, for example by aborting the model call with the
   * same signal. Track the last serial inside the loop if it is needed after
   * it.
   * @param source - The events to write, a ReadableStream or an async iterable.
   * @param options - The pipe's abort signal and the call's headers.
   * @returns The events, each with the serial of the message it landed on.
   * @throws {Ably.ErrorInfo} `InvalidArgument`, thrown by this call itself and not from the loop, when a header value is not a string, number, boolean or null; from the loop, `OperationCancelled` when the signal fires and `PipeFailed` when the source throws, the codec cannot encode an event or encodes a message without its `name` and `id`, a publish or update fails, or a repair fails, with the failure as `cause`; `PipeFailed` from the loop's exit when the repair after a `break` or `return` fails.
   */
  pipeEach(source: PipeSource<E>, options?: PipeOptions): AsyncIterable<Published<E>>;
  /**
   * Open an event writer: the way to write a stream of events when the
   * caller is handed them one at a time and owns no source to pipe. `write`
   * hands an event over and returns without waiting for the channel, as the
   * Pub/Sub message stream's `append` does; `pipe` and `pipeEach` are loops
   * over a writer of their own. The writer keeps one key table for its life,
   * and nothing is published until the first `write`. Its `flush` waits until
   * what was written is on the channel, keeps the writer open and resolves
   * with the serial of the message the last event landed on; its `close`
   * does the same and then refuses later writes, ending no open stream.
   * `await using` closes the writer too. An event that cannot be written
   * throws at its `write` and the writer carries on; a failure to get a write
   * onto the channel stops the writer, so `flush` and `close` resolve only
   * when nothing handed over was lost. Both also resolve with a handoff naming
   * the streams left open: to carry a stream on in another writer, in
   * another process for instance, give the handoff to
   * {@link AgentAdaptor.adoptWriter}, which writes the stream's later events
   * to the same message. A new writer given those events without the handoff
   * opens new messages for them. A stream stays open in the writer until its
   * end event is written, so close the writer before reusing the key of a
   * stream that was never ended. See {@link EventWriter}.
   * @param options - The writer's headers.
   * @returns The writer.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when a header value is not a string, number, boolean or null.
   */
  newWriter(options?: WriterOptions): EventWriter<E>;
  /**
   * Give out an event writer that carries on the streams another writer left
   * open, as `newWriter` does otherwise. The handoff comes from that writer's
   * `flush` or `close`, and may have been stored and read back as JSON. A
   * later event of an adopted stream appends to the message the other writer
   * opened, and its end event ends that message, so each stream stays on one
   * serial and a decoder forgets it once it ends. The first write to an
   * adopted stream reads its message back with the channel's `getMessage`,
   * so a failed append can be repaired with the message's whole content; a
   * failed read stops the writer with the channel's error. Adopt a handoff
   * once the writer it came from has closed, or both write to the same
   * messages. An empty handoff gives the same writer as `newWriter`.
   * @param handoff - The handoff, from {@link EventWriterResult.handoff}.
   * @param options - The writer's headers.
   * @returns The writer.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when the handoff is not one a writer gave out, when it names a stream and the channel has no `getMessage`, or when a header value is not a string, number, boolean or null.
   */
  adoptWriter(handoff: WriterHandoff, options?: WriterOptions): EventWriter<E>;
}

/**
 * The streams a handoff names, checked: it may have been stored and read back
 * as JSON, so it is validated as data from outside.
 * @param handoff - The handoff.
 * @returns Its streams.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when it is not an object with a `streams` array of `{ key, serial }` strings, each key named once.
 */
const adoptedStreams = (handoff: WriterHandoff): OpenStream[] => {
  // CAST: the handoff may have been read back from JSON, so its shape is checked rather than trusted.
  const streams = (handoff as { streams?: unknown } | null | undefined)?.streams;
  if (!Array.isArray(streams)) {
    throw new Ably.ErrorInfo(
      'unable to adopt writer; the handoff has no streams array',
      ErrorCode.InvalidArgument,
      400,
    );
  }
  const keys = new Set<string>();
  return streams.map((entry: unknown): OpenStream => {
    // CAST: each entry is checked field by field below.
    const { key, serial } = (entry ?? {}) as { key?: unknown; serial?: unknown };
    if (typeof key !== 'string' || typeof serial !== 'string' || serial === '' || keys.has(key)) {
      throw new Ably.ErrorInfo(
        'unable to adopt writer; each stream in the handoff needs a key of its own and a serial',
        ErrorCode.InvalidArgument,
        400,
      );
    }
    keys.add(key);
    return { key, serial };
  });
};

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
    isPermission ? ErrorCode.InsufficientCapability : ErrorCode.WriteFailed,
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
    const writer = this._eventWriter(prepareHeaders(options?.headers, 'pipe'));
    return pipeStream(source, writer, { signal: options?.signal, logger: this._logger });
  }

  pipeEach(source: PipeSource<E>, options?: PipeOptions): AsyncIterable<Published<E>> {
    this._logger.trace('AgentAdaptor.pipeEach();', { headers: Object.keys(options?.headers ?? {}) });
    const writer = this._eventWriter(prepareHeaders(options?.headers, 'pipe'));
    return pipeEachDriver(source, writer, { signal: options?.signal, logger: this._logger });
  }

  newWriter(options?: WriterOptions): EventWriter<E> {
    this._logger.trace('AgentAdaptor.newWriter();', { headers: Object.keys(options?.headers ?? {}) });
    return this._eventWriter(prepareHeaders(options?.headers, 'create writer'));
  }

  adoptWriter(handoff: WriterHandoff, options?: WriterOptions): EventWriter<E> {
    const streams = adoptedStreams(handoff);
    this._logger.trace('AgentAdaptor.adoptWriter();', {
      streams: streams.length,
      headers: Object.keys(options?.headers ?? {}),
    });
    if (streams.length > 0 && this._channel.getMessage === undefined) {
      this._logger.error('AgentAdaptor.adoptWriter(); the channel cannot read a message');
      throw new Ably.ErrorInfo(
        'unable to adopt writer; the channel has no getMessage, so it cannot read an adopted message back',
        ErrorCode.InvalidArgument,
        400,
      );
    }
    return this._eventWriter(prepareHeaders(options?.headers, 'adopt writer'), streams);
  }

  /**
   * Open an event writer with a key table of its own, writing through the
   * adaptor's codec.
   * @param headers - The call's headers, already checked, laid over the adaptor's defaults.
   * @param adopted - Streams another writer left open, which this one carries on.
   * @returns The writer.
   */
  private _eventWriter(headers: MessageHeaders | undefined, adopted: OpenStream[] = []): DefaultEventWriter<E> {
    const writer = createPipeWriter(this._channel, this._logger, adopted);
    return createEventWriter(createCodecSink(this._codec, writer, mergeHeaders(this._headers, headers)), {
      logger: this._logger,
    });
  }

  /**
   * Publish one message and return its ack serial.
   * @param message - The message.
   * @returns The ack serial.
   * @throws {Ably.ErrorInfo} `InsufficientCapability` or `WriteFailed` when the publish fails; `InternalError` when the ack carries no serial.
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
