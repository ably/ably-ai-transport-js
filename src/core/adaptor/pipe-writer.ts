/**
 * Pipe writer — one event writer's key table, a pipe's included.
 *
 * A codec names streams by its own keys (a message id, a tool call id, a block
 * index) because it cannot know the serial a publish ack returns. The writer
 * keeps that table for the life of the event writer that holds it, from each
 * key to the message stream that writes its message (`message-stream.ts`).
 * `publish` under a key opens a message stream. `append` to a key that is not
 * live opens one with the message, so a stream's first delta opens the message
 * the later deltas append to; `append` to a live key appends through its
 * stream. `update` routes to a live key's stream, and `ends` forgets a key. The
 * table, and the markers below, are the codec's wire format; the writes to one
 * message and their repair are the message stream's.
 *
 * The first delta opens the message because Ably's append replaces the stored
 * `name` and `extras` with the append's own. A message opened by a start event
 * and grown by deltas would read back from history under the last append's
 * type, with the whole text on a message the start event's row cannot decode.
 * With the deltas alone sharing a message, history holds the start, one delta
 * carrying the joined text, and the end, and the decoded sequence folds like
 * the live one.
 *
 * The writer stamps two fields of its own under `extras.ai`: `stream: true` on
 * every write under a live key (the publish that opens it, each append, each
 * update), and `ends` on the message that ends a key, carrying the serial the
 * key table holds for it. They tell a decoder which messages to remember and
 * when to forget them. Ably stores the last write's extras on an appended
 * message, so stamping every write keeps `stream` on the message however it is
 * read back. A plain publish with no key carries neither.
 *
 * A message stream sends appends as they arrive and never awaits them one by
 * one, so a token stream runs at the speed of the connection rather than one
 * round trip per token. A realtime connection keeps them in order, and a
 * discrete publish needs no ordering against them. The writer flushes a stream
 * where it ends and when the event writer flushes, and a stream whose append
 * failed is repaired there with one full-content update, before the message
 * that ends it, so history holds the whole message, a live subscriber reads the
 * missing text as the update's tail, and the closer is the last write a decoder
 * sees for the stream. A closer that appends to the key it ends is the one
 * shape repaired after itself when that append fails; no shipped row does that.
 *
 * One platform behaviour shapes the one wait the writer does: the append
 * rollup. Ably holds the appends a connection publishes within a window (40ms
 * by default, the `appendRollupWindow` transport param on the publishing
 * client) and delivers them as one message with the data joined and only the
 * last append's extras, while a plain publish is not held. Order and content
 * survive that within a stream, but the message that ends a stream carries
 * its own type and no text: rolled up with the delta before it, that delta's
 * text would decode under the closer's type; published while the delta is
 * held, it would reach subscribers first. The writer therefore waits for a
 * stream's pending acks before sending the message that ends it, append or
 * publish, and for nothing else. A publisher that sets the window to 0 gets
 * one delivery per append, and the wait then costs one round trip per stream.
 *
 * That wait orders a stream against its own closer and nothing else. The
 * platform does not order a create against an append, so a publish that
 * opens another stream, or a plain publish, can reach subscribers ahead of
 * an open stream's held appends.
 */

import * as Ably from '@ably/pubsub-core';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause } from '../../utils.js';
import type { EncodedMessage } from '../codec/codec.js';
import { ENDS_FIELD, STREAM_FIELD, withOwnField } from '../wire.js';
import { type ChannelWriter, type MessageStream, openMessageStream, publishMessage } from './message-stream.js';

/** Where one write landed. */
export interface WriteResult {
  /** The serial of the message the write landed on: a publish's ack serial, or for an append or an update, the serial of the stream's message. */
  serial: string;
  /** Whether the write was a publish, including the publish an append to a key not yet live becomes. */
  published: boolean;
}

/** One event writer's key table. */
export interface PipeWriter {
  /**
   * Perform the operation an encoded message asks for, and resolve with where
   * it landed. A publish resolves once acked, with its ack serial, and so does
   * the publish that an append to a key not yet live becomes. An append to a
   * live key resolves at once with the stream's serial, before its ack; its
   * failure surfaces from the flush that runs when its stream ends or the
   * event writer flushes. An update resolves once acked, with the stream's
   * serial.
   * @throws {Ably.ErrorInfo} `InvalidArgument` for a publish under a live key or an update to a key that is not live; `InternalError` when a publish returns no serial; `StreamedMessageFinalizeFailed` when a stream this message ends could not be repaired.
   */
  write(encoded: EncodedMessage): Promise<WriteResult>;
  /**
   * Await every pending append and repair each stream whose append failed with
   * one full-content update.
   * @throws {Ably.ErrorInfo} `StreamedMessageFinalizeFailed` when a repair fails; the first repair failure is the `cause`.
   */
  flush(): Promise<void>;
}

/**
 * The error for repairs that failed: `StreamedMessageFinalizeFailed`, with the
 * first failure as `cause`.
 * @param failures - What each failed repair threw.
 * @param needed - How many streams needed a repair.
 * @returns The error.
 */
const repairFailed = (failures: unknown[], needed: number): Ably.ErrorInfo =>
  new Ably.ErrorInfo(
    `unable to repair stream; ${String(failures.length)} of ${String(needed)} repairs failed`,
    ErrorCode.StreamedMessageFinalizeFailed,
    500,
    errorCause(failures[0]),
  );

class DefaultPipeWriter implements PipeWriter {
  private readonly _channel: ChannelWriter;
  private readonly _logger: Logger | undefined;
  private readonly _streams = new Map<string, MessageStream>();
  private _flushing: Promise<void> | undefined;

  constructor(channel: ChannelWriter, logger: Logger | undefined) {
    this._channel = channel;
    this._logger = logger?.withContext({ component: 'PipeWriter' });
  }

  async write(encoded: EncodedMessage): Promise<WriteResult> {
    const { message, publish, append, update, ends } = encoded;
    let result: WriteResult;

    // The message that ends a stream lands after the stream's appends and the
    // repair of any that failed: sent behind an unacked delta it could be
    // rolled up with it or overtake it, and a repair sent after it would reach
    // a decoder that has already forgotten the stream.
    if (ends !== undefined) await this._settle(ends);
    const ended = ends === undefined ? undefined : this._streams.get(ends)?.serial;
    const closing = ended === undefined ? message : withOwnField(message, ENDS_FIELD, ended);
    const marked = withOwnField(closing, STREAM_FIELD, true);

    if (append !== undefined) {
      // The first append of a stream opens its message; see the module comment.
      const stream = this._streams.get(append);
      if (stream === undefined) {
        result = { serial: await this._open(append, marked), published: true };
      } else {
        stream.append(marked);
        result = { serial: stream.serial, published: false };
      }
    } else if (update !== undefined) {
      result = { serial: await this._update(update, marked), published: false };
    } else if (publish === undefined) {
      this._logger?.trace('PipeWriter.write(); publish', { name: closing.name });
      result = { serial: await publishMessage(this._channel, closing), published: true };
    } else {
      result = { serial: await this._open(publish, marked), published: true };
    }

    if (ends !== undefined) {
      // An append that ends its own key is acked, and repaired if it failed,
      // before the key goes.
      await this._settle(ends);
      this._streams.delete(ends);
      this._logger?.debug('PipeWriter.write(); stream ended', { key: ends, serial: ended });
    }

    return result;
  }

  async flush(): Promise<void> {
    // Re-entrancy guard: a flush in progress is the flush.
    if (this._flushing) return this._flushing;
    this._logger?.trace('PipeWriter.flush();', { streams: this._streams.size });
    this._flushing = this._repair([...this._streams.values()]);
    try {
      await this._flushing;
    } finally {
      this._flushing = undefined;
    }
  }

  private async _open(key: string, message: Ably.Message): Promise<string> {
    if (this._streams.has(key)) {
      throw new Ably.ErrorInfo(
        `unable to publish; key '${key}' is still live, use update to replace its content or end it first`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    this._logger?.trace('PipeWriter.write(); publish', { name: message.name, key });
    const stream = await openMessageStream(this._channel, message, this._logger?.withContext({ key }));
    this._streams.set(key, stream);
    this._logger?.debug('PipeWriter.write(); stream opened', { key, serial: stream.serial });
    return stream.serial;
  }

  /**
   * Flush one stream and repair it if an append failed, so the message that
   * ends the stream is the last write on its message.
   * @param key - The stream.
   * @throws {Ably.ErrorInfo} `StreamedMessageFinalizeFailed` when the repair fails.
   */
  private async _settle(key: string): Promise<void> {
    const stream = this._streams.get(key);
    if (stream === undefined) return;
    this._logger?.trace('PipeWriter.write(); settling appends before the message that ends the stream', { key });
    await this._repair([stream]);
  }

  private async _update(key: string, message: Ably.Message): Promise<string> {
    const stream = this._streams.get(key);
    if (stream === undefined) {
      throw new Ably.ErrorInfo(`unable to update; no live stream for key '${key}'`, ErrorCode.InvalidArgument, 400);
    }
    this._logger?.trace('PipeWriter.write(); update', { key, serial: stream.serial });
    await stream.update(message);
    return stream.serial;
  }

  /**
   * Flush streams, repairing each whose append failed.
   * @param streams - The streams.
   * @throws {Ably.ErrorInfo} `StreamedMessageFinalizeFailed` when a repair fails, with the first failure as `cause`.
   */
  private async _repair(streams: MessageStream[]): Promise<void> {
    const results = await Promise.allSettled(streams.map(async (stream) => stream.flush()));
    const failures: unknown[] = [];
    let repaired = 0;
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
      else if (result.value) repaired += 1;
    }
    if (failures.length > 0) throw repairFailed(failures, repaired + failures.length);
  }
}

/**
 * Create a pipe writer for one event writer.
 * @param channel - The channel to write to.
 * @param logger - Logger for diagnostics.
 * @returns A new {@link PipeWriter}.
 */
export const createPipeWriter = (channel: ChannelWriter, logger?: Logger): PipeWriter =>
  new DefaultPipeWriter(channel, logger);
