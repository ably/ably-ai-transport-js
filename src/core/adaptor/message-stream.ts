/**
 * Message stream — the writes to one streamed message, and its repair.
 *
 * It opens the message with a publish, appends to it without waiting for each
 * ack, replaces its content with an update, and keeps the content the stored
 * message should hold, so that when an append fails it can repair the message
 * with one full-content update. It knows nothing of a codec's stream keys or of
 * the markers a decoder reads: the pipe writer maps keys to message streams and
 * stamps the markers on what it hands over.
 *
 * It stands in for the Pub/Sub SDK's message stream and has its shape where
 * the pipes' behaviour allows: `append` returns without waiting, `flush`
 * waits for the appends and repairs, and `serial` names the message. An
 * `update` is awaited and its failure thrown, where the SDK repairs a failed
 * one, since a pipe reports a failed update.
 */

import * as Ably from '@ably/pubsub-core';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorMessage } from '../../utils.js';

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
  /**
   * Read the latest version of the message named by `serial`, with its whole
   * content. Only a writer that adopts another writer's open streams needs it,
   * so it is optional: a channel without it serves every other write.
   * @param serial - The serial of the message to read.
   * @returns The message.
   */
  getMessage?(serial: string): Promise<Ably.Message>;
}

const stringOf = (data: unknown): string => (typeof data === 'string' ? data : '');

/**
 * Publish one message and return its serial.
 * @param channel - The channel.
 * @param message - The message.
 * @returns The serial the ack names.
 * @throws {Ably.ErrorInfo} `InternalError` when the ack carries no serial; whatever the channel throws.
 */
export const publishMessage = async (channel: ChannelWriter, message: Ably.Message): Promise<string> => {
  const result = await channel.publish(message);
  const serial = result.serials[0] ?? undefined;
  if (serial === undefined) {
    throw new Ably.ErrorInfo('unable to publish; no serial returned', ErrorCode.InternalError, 500);
  }
  return serial;
};

/** The writes to one streamed message, which a pipe writer opens with {@link openMessageStream}. */
export class MessageStream {
  /** The serial of the message the stream writes to. */
  readonly serial: string;
  private readonly _channel: ChannelWriter;
  private readonly _logger: Logger | undefined;
  /** The text written to the message so far, for a repair. */
  private _data: string;
  /** The name the last write carried, re-stamped by a repair because Ably replaces the name on update. */
  private _name: string | undefined;
  /** The extras the last write carried, re-stamped by a repair because Ably replaces extras on update. */
  private _extras: unknown;
  /** The appends sent and not yet collected by a flush. */
  private _pending: Promise<Ably.UpdateDeleteResult>[] = [];

  constructor(channel: ChannelWriter, serial: string, message: Ably.Message, logger: Logger | undefined) {
    this._channel = channel;
    this.serial = serial;
    this._data = stringOf(message.data);
    this._name = message.name;
    this._extras = message.extras;
    this._logger = logger?.withContext({ component: 'MessageStream' });
  }

  /**
   * Append to the message. Returns without waiting for the ack; a flush
   * collects it, and repairs the message if it failed.
   * @param message - The fragment. Its `serial` is ignored.
   */
  append(message: Ably.Message): void {
    this._data += stringOf(message.data);
    this._name = message.name;
    this._extras = message.extras;
    const promise = this._channel.appendMessage({ ...message, serial: this.serial });
    // Not awaited here: the ack is collected by flush. The catch keeps an
    // early rejection from surfacing as unhandled before flush collects it,
    // and warns, since the channel is missing that text until the flush
    // repairs the message.
    promise.catch((error: unknown) => {
      this._logger?.warn('MessageStream.append(); append failed, the next flush repairs the stream', {
        serial: this.serial,
        error: errorMessage(error),
      });
    });
    this._pending.push(promise);
  }

  /**
   * Replace the message's content, and wait for the ack.
   * @param message - The new content. Its `serial` is ignored.
   * @throws Whatever the channel throws.
   */
  async update(message: Ably.Message): Promise<void> {
    this._logger?.trace('MessageStream.update();', { serial: this.serial });
    await this._channel.updateMessage({ ...message, serial: this.serial });
    this._data = stringOf(message.data);
    this._name = message.name;
    this._extras = message.extras;
  }

  /**
   * Wait for the appends sent so far and, if one failed, repair the message
   * with one update that carries its whole content.
   * @returns Whether a failed append made it repair the message.
   * @throws Whatever the channel throws for the repair.
   */
  async flush(): Promise<boolean> {
    const pending = this._pending;
    this._pending = [];
    if (pending.length === 0) return false;
    const results = await Promise.allSettled(pending);
    if (!results.some((result) => result.status === 'rejected')) return false;

    this._logger?.warn('MessageStream.flush(); repairing the message after a failed append', { serial: this.serial });
    try {
      await this._channel.updateMessage({
        serial: this.serial,
        name: this._name,
        data: this._data,
        extras: this._extras,
      });
    } catch (error) {
      this._logger?.error('MessageStream.flush(); repair failed', { serial: this.serial, error: errorMessage(error) });
      throw error;
    }
    return true;
  }
}

/**
 * Carry on writing to a message another writer opened: read its whole content,
 * so a repair can rebuild it, and return a stream that appends to it.
 * @param channel - The channel. It must be able to read a message.
 * @param serial - The serial of the message.
 * @param logger - Logger for diagnostics.
 * @returns The stream.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when the channel cannot read a message; whatever the channel throws for the read.
 */
export const adoptMessageStream = async (
  channel: ChannelWriter,
  serial: string,
  logger?: Logger,
): Promise<MessageStream> => {
  if (channel.getMessage === undefined) {
    throw new Ably.ErrorInfo(
      'unable to adopt stream; the channel cannot read a message, so it has no getMessage',
      ErrorCode.InvalidArgument,
      400,
    );
  }
  return new MessageStream(channel, serial, await channel.getMessage(serial), logger);
};

/**
 * Publish a message and return a stream that writes to it.
 * @param channel - The channel.
 * @param message - The message that opens the stream; the stream starts from its content.
 * @param logger - Logger for diagnostics.
 * @returns The stream.
 * @throws {Ably.ErrorInfo} As {@link publishMessage}.
 */
export const openMessageStream = async (
  channel: ChannelWriter,
  message: Ably.Message,
  logger?: Logger,
): Promise<MessageStream> => new MessageStream(channel, await publishMessage(channel, message), message, logger);
