/**
 * Pipe writer — one pipe's key table and its append pipeline.
 *
 * A codec names streams by its own keys (a message id, a tool call id, a block
 * index) because it cannot know the serial a publish ack returns. The writer
 * keeps that table for the life of one pipe. `publish` under a key remembers
 * the serial. `append` to a key that is not live publishes the message, awaits
 * the ack and remembers its serial under the key, so a stream's first delta
 * opens the message the later deltas append to; `append` to a live key appends.
 * `update` routes to a live key, and `ends` forgets a key.
 *
 * The first delta opens the message because Ably's append replaces the stored
 * `name` and `extras` with the append's own. A message opened by a start event
 * and grown by deltas would read back from history under the last append's
 * type, with the whole text on a message the start event's row cannot decode.
 * With the deltas alone sharing a message, history holds the start, one delta
 * carrying the joined text, and the end, and the decoded sequence folds like
 * the live one.
 *
 * The writer sets two fields of its own under `extras.ai`: `stream: true` on a
 * write that streams (the publish that opens a key, each append, and the
 * repair of a failed one), and `ends` on the message that ends a key, carrying
 * the serial the key table holds for it. They tell a decoder which messages to
 * remember, when to forget them, and which updates carry text a subscriber may
 * already have. Ably stores the last write's extras on an appended message, so
 * marking every write that streams keeps `stream` on the message however it is
 * read back. An `update:` write replaces a message's content, so the writer
 * leaves `stream` off it and a subscriber reads it whole. A plain publish with
 * no key carries neither field.
 *
 * Appends are sent as they arrive and never awaited by the pipe loop, so a
 * token stream runs at the speed of the connection rather than one round trip
 * per token. A realtime connection keeps them in order, and a discrete publish
 * needs no ordering against them. Their acks are awaited where a stream ends
 * and when the pipe ends, and a stream whose append failed is repaired there
 * with one full-content `updateMessage`, before the message that ends it, so
 * history holds the whole message, a live subscriber reads the missing text as
 * the update's tail, and the closer is the last write a decoder sees for the
 * stream. A closer that appends to the key it ends is the one shape repaired
 * after itself when that append fails; no shipped row does that.
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
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { EncodedMessage } from '../codec/codec.js';
import { ENDS_FIELD, STREAM_FIELD, withOwnField } from '../wire.js';

/**
 * The channel operations the writer needs. An `Ably.RealtimeChannel` satisfies
 * it directly; tests supply a fake.
 */
export interface ChannelWriter {
  /**
   * Publish a new message.
   * @param message - The message to publish.
   * @returns The ack, whose first serial names the new message.
   */
  publish(message: Ably.Message): Promise<Ably.PublishResult>;
  /**
   * Append `data` to the message named by `message.serial`.
   * @param message - The fragment, with the serial of the message to append to.
   * @returns The ack.
   */
  appendMessage(message: Ably.Message): Promise<Ably.UpdateDeleteResult>;
  /**
   * Replace the content of the message named by `message.serial`.
   * @param message - The new content, with the serial of the message to replace.
   * @returns The ack.
   */
  updateMessage(message: Ably.Message): Promise<Ably.UpdateDeleteResult>;
}

/** One pipe's writer. */
export interface PipeWriter {
  /**
   * Perform the operation an encoded message asks for. Resolves with the ack
   * serial of a publish, including the publish that an append to a key not yet
   * live becomes, and with `undefined` for an append to a live key or an
   * update. An append to a live key is not awaited; its failure surfaces from
   * the flush that runs when its stream ends or the pipe ends.
   * @throws {Ably.ErrorInfo} `InvalidArgument` for a publish under a live key or an update to a key that is not live; `InternalError` when a publish returns no serial; `StreamedMessageFinalizeFailed` when a stream this message ends could not be repaired.
   */
  write(encoded: EncodedMessage): Promise<string | undefined>;
  /**
   * Await every pending append and repair each stream whose append failed with
   * one full-content update.
   * @throws {Ably.ErrorInfo} `StreamedMessageFinalizeFailed` when a repair fails; the first repair failure is the `cause`.
   */
  flush(): Promise<void>;
}

interface StreamState {
  serial: string;
  /** The text written to the message so far, for a repair. */
  accumulated: string;
  /** The extras the last write carried, re-stamped by a repair because Ably replaces extras on update. */
  extras: unknown;
}

interface PendingAppend {
  key: string;
  promise: Promise<Ably.UpdateDeleteResult>;
}

const stringOf = (data: unknown): string => (typeof data === 'string' ? data : '');

class DefaultPipeWriter implements PipeWriter {
  private readonly _channel: ChannelWriter;
  private readonly _logger: Logger | undefined;
  private readonly _streams = new Map<string, StreamState>();
  private _pending: PendingAppend[] = [];
  private _flushing: Promise<void> | undefined;

  constructor(channel: ChannelWriter, logger: Logger | undefined) {
    this._channel = channel;
    this._logger = logger?.withContext({ component: 'PipeWriter' });
  }

  async write(encoded: EncodedMessage): Promise<string | undefined> {
    const { message, publish, append, update, ends } = encoded;
    let serial: string | undefined;

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
        serial = await this._publish(append, marked);
      } else {
        this._append(append, stream, marked);
      }
    } else if (update === undefined) {
      serial = await this._publish(publish, publish === undefined ? closing : marked);
    } else {
      // An `update:` write replaces the message's content, so it goes without
      // `stream` and a subscriber reads it whole.
      await this._update(update, closing);
    }

    if (ends !== undefined) {
      // An append that ends its own key is acked, and repaired if it failed,
      // before the key goes.
      await this._settle(ends);
      this._streams.delete(ends);
      this._logger?.debug('PipeWriter.write(); stream ended', { key: ends, serial: ended });
    }

    return serial;
  }

  async flush(): Promise<void> {
    // Re-entrancy guard: a flush in progress is the flush.
    if (this._flushing) return this._flushing;
    const snapshot = this._pending;
    this._pending = [];
    if (snapshot.length === 0) return;

    this._logger?.trace('PipeWriter.flush();', { pending: snapshot.length });
    this._flushing = this._repair(snapshot);
    try {
      await this._flushing;
    } finally {
      this._flushing = undefined;
    }
  }

  private async _publish(key: string | undefined, message: Ably.Message): Promise<string> {
    if (key !== undefined && this._streams.has(key)) {
      throw new Ably.ErrorInfo(
        `unable to publish; key '${key}' is still live, use update to replace its content or end it first`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    this._logger?.trace('PipeWriter.write(); publish', { name: message.name, key });
    const result = await this._channel.publish(message);
    const serial = result.serials[0] ?? undefined;
    if (serial === undefined) {
      throw new Ably.ErrorInfo('unable to publish; no serial returned', ErrorCode.InternalError, 500);
    }
    if (key !== undefined) {
      this._streams.set(key, { serial, accumulated: stringOf(message.data), extras: message.extras });
      this._logger?.debug('PipeWriter.write(); stream opened', { key, serial });
    }
    return serial;
  }

  private _append(key: string, stream: StreamState, message: Ably.Message): void {
    stream.accumulated += stringOf(message.data);
    stream.extras = message.extras;
    const promise = this._channel.appendMessage({ ...message, serial: stream.serial });
    // Not awaited here: the ack is collected by flush. The no-op catch keeps an
    // early rejection from surfacing as unhandled before flush collects it.
    promise.catch(() => {
      /* collected by flush */
    });
    this._pending.push({ key, promise });
  }

  /**
   * Await the pending appends of one stream and repair it if any failed, so
   * the message that ends the stream is the last write on its message.
   * @param key - The stream.
   * @throws {Ably.ErrorInfo} `StreamedMessageFinalizeFailed` when the repair fails.
   */
  private async _settle(key: string): Promise<void> {
    const own = this._pending.filter((p) => p.key === key);
    if (own.length === 0) return;
    this._pending = this._pending.filter((p) => p.key !== key);
    this._logger?.trace('PipeWriter.write(); settling appends before the message that ends the stream', {
      key,
      pending: own.length,
    });
    await this._repair(own);
  }

  private async _update(key: string, message: Ably.Message): Promise<void> {
    const stream = this._streams.get(key);
    if (stream === undefined) {
      throw new Ably.ErrorInfo(`unable to update; no live stream for key '${key}'`, ErrorCode.InvalidArgument, 400);
    }
    this._logger?.trace('PipeWriter.write(); update', { key, serial: stream.serial });
    await this._channel.updateMessage({ ...message, serial: stream.serial });
    stream.accumulated = stringOf(message.data);
    stream.extras = message.extras;
  }

  private async _repair(snapshot: PendingAppend[]): Promise<void> {
    const results = await Promise.allSettled(snapshot.map(async (p) => p.promise));
    const failed = new Set<string>();
    for (const [i, result] of results.entries()) {
      const entry = snapshot[i];
      if (entry !== undefined && result.status === 'rejected') failed.add(entry.key);
    }
    if (failed.size === 0) return;

    this._logger?.warn('PipeWriter.flush(); repairing streams with failed appends', { keys: [...failed] });
    const failures: unknown[] = [];
    for (const key of failed) {
      const stream = this._streams.get(key);
      if (stream === undefined) continue;
      try {
        // A repair rewrites the text the appends built, so `stream` belongs on
        // it. Set here, since `stream.extras` holds the extras of whichever
        // write came last.
        const repaired = withOwnField({ data: stream.accumulated, extras: stream.extras }, STREAM_FIELD, true);
        await this._channel.updateMessage({ ...repaired, serial: stream.serial });
      } catch (error) {
        this._logger?.error('PipeWriter.flush(); repair failed', { key, error: errorMessage(error) });
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new Ably.ErrorInfo(
        `unable to repair stream; ${String(failures.length)} of ${String(failed.size)} repairs failed`,
        ErrorCode.StreamedMessageFinalizeFailed,
        500,
        errorCause(failures[0]),
      );
    }
  }
}

/**
 * Create a writer for one pipe.
 * @param channel - The channel to write to.
 * @param logger - Logger for diagnostics.
 * @returns A new {@link PipeWriter}.
 */
export const createPipeWriter = (channel: ChannelWriter, logger?: Logger): PipeWriter =>
  new DefaultPipeWriter(channel, logger);
