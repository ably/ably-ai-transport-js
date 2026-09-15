/**
 * Decoder core — the per-serial state a built codec keeps so that one codec
 * instance can decode live delivery and history together.
 *
 * Ably delivers a streamed message three ways. A live append carries only its
 * fragment. The first delivery after an attach carries the full content so far
 * as a `message.update`. A history read returns the whole message at whatever
 * version it has reached. The core reduces all three to one shape before a
 * codec row's decode runs: `data` is what this delivery adds.
 *
 * To do that it keeps, per serial, the text it has handed on and the highest
 * `version.serial` it has incorporated. The version guard drops a delivery the
 * decoder has already seen, which is what lets history overlap live delivery
 * without duplicates. The table holds only the messages that are streams: a
 * create the pipe writer marked with `extras.ai.stream`, which is on every
 * write under a live key and so on the message however it is read back, and
 * any serial first met through an append or an update. The message that ends
 * a key carries the serial it ends under `extras.ai.ends`, and the core
 * forgets that serial when it sees it; a delete forgets its serial too. A
 * plain publish is handed on and never remembered.
 *
 * A closer can arrive before the stream it ends: history walks newest page
 * first, so when the two sit on different pages the closer is decoded first.
 * The core remembers such a closer's serial, and when the stream's message
 * arrives it is handed on whole and never tracked, since nothing will follow
 * it. A closer whose stream never reaches this decoder leaves its serial in
 * that set.
 */

import type * as Ably from 'ably';

import type { Logger } from '../../logger.js';
import { ENDS_FIELD, readOwnExtras, STREAM_FIELD } from '../wire.js';

/** Options for {@link createDecoderCore}. */
export interface DecoderCoreOptions {
  /** Logger for diagnostics. */
  logger?: Logger;
}

/** The decoder core returned by {@link createDecoderCore}. */
export interface DecoderCore {
  /**
   * Reduce one inbound message to what it adds. Returns the message to decode,
   * with `data` replaced by the unseen tail where the delivery carried content
   * the core had already handed on, or `undefined` when nothing should be
   * decoded: a replay the core has already incorporated, an update that adds
   * nothing, or a `message.delete`.
   * @param message - The inbound message, as the channel delivered it.
   * @returns The message to decode, or `undefined`.
   */
  prepare(message: Ably.InboundMessage): Ably.InboundMessage | undefined;
}

interface SerialState {
  /** The text handed on for this serial so far. */
  accumulated: string;
  /** The highest `version.serial` incorporated. A never-mutated message's version is its own serial. */
  version: string;
}

const stringData = (message: Ably.InboundMessage): string => (typeof message.data === 'string' ? message.data : '');

/**
 * Whether the pipe writer marked a message as a stream's.
 * @param message - The delivery.
 * @returns True when `extras.ai.stream` is set.
 */
const isStream = (message: Ably.InboundMessage): boolean => readOwnExtras(message.extras)?.[STREAM_FIELD] === true;

/**
 * The serial a closer ends, when the message carries one.
 * @param message - The delivery.
 * @returns The serial under `extras.ai.ends`, or `undefined`.
 */
const endedSerial = (message: Ably.InboundMessage): string | undefined => {
  const ended = readOwnExtras(message.extras)?.[ENDS_FIELD];
  return typeof ended === 'string' ? ended : undefined;
};

class DefaultDecoderCore implements DecoderCore {
  private readonly _state = new Map<string, SerialState>();
  /** The serials whose closer arrived before the message it ends. */
  private readonly _closed = new Set<string>();
  private readonly _logger: Logger | undefined;

  constructor(options: DecoderCoreOptions) {
    this._logger = options.logger?.withContext({ component: 'DecoderCore' });
  }

  prepare(message: Ably.InboundMessage): Ably.InboundMessage | undefined {
    const serial = message.serial;
    // A message with no serial cannot be tracked; hand it on as it is.
    if (serial === undefined || serial === '') return message;
    const prepared = this._reduce(message, serial);
    // After the reduction, so a closer is itself reduced and handed on before
    // the serial it names is forgotten.
    this._end(message);
    return prepared;
  }

  private _reduce(message: Ably.InboundMessage, serial: string): Ably.InboundMessage | undefined {
    switch (message.action) {
      case 'message.create': {
        return this._create(message, serial);
      }
      case 'message.append': {
        return this._append(message, serial);
      }
      case 'message.update': {
        return this._update(message, serial);
      }
      case 'message.delete': {
        this._delete(serial);
        return undefined;
      }
      default: {
        return message;
      }
    }
  }

  private _create(message: Ably.InboundMessage, serial: string): Ably.InboundMessage | undefined {
    if (this._state.has(serial)) {
      // A create is the message's first version, so a tracked serial has
      // already incorporated it (a resume retransmission, a history replay).
      this._logger?.debug('DefaultDecoderCore.prepare(); duplicate create, dropping', { serial });
      return undefined;
    }
    // Only a stream's message is remembered: appends may follow it, and a
    // late joiner's full-content update for it must reduce to the tail. A
    // stream whose closer has already passed is over, so nothing follows it.
    if (isStream(message) && !this._alreadyEnded(serial)) {
      this._state.set(serial, { accumulated: stringData(message), version: versionOf(message, serial) });
    }
    return message;
  }

  private _append(message: Ably.InboundMessage, serial: string): Ably.InboundMessage | undefined {
    const state = this._state.get(serial);
    if (state === undefined) {
      // First contact through an append: the platform normally converts the
      // first post-attach append into a full-content update, so this is a
      // delivery the core cannot reduce further. Hand it on as it is.
      this._logger?.debug('DefaultDecoderCore.prepare(); append for an untracked serial', { serial });
      if (!this._alreadyEnded(serial)) {
        this._state.set(serial, { accumulated: stringData(message), version: versionOf(message, serial) });
      }
      return message;
    }
    if (this._alreadyIncorporated(state, message, serial)) return undefined;
    state.accumulated += stringData(message);
    return message;
  }

  private _update(message: Ably.InboundMessage, serial: string): Ably.InboundMessage | undefined {
    const state = this._state.get(serial);
    const data = stringData(message);
    if (state === undefined) {
      // First contact: a late joiner's first delivery of an in-flight stream,
      // or a history read of a message that was updated. The whole content is
      // what this delivery adds.
      if (!this._alreadyEnded(serial)) {
        this._state.set(serial, { accumulated: data, version: versionOf(message, serial) });
      }
      return message;
    }
    if (this._alreadyIncorporated(state, message, serial)) return undefined;

    if (data.startsWith(state.accumulated)) {
      const tail = data.slice(state.accumulated.length);
      state.accumulated = data;
      if (tail.length === 0) {
        this._logger?.debug('DefaultDecoderCore.prepare(); update adds nothing, dropping', { serial });
        return undefined;
      }
      // A shallow copy with `data` replaced by the unseen tail. The row's
      // decode reads fields only, so the prototype is not needed.
      return { ...message, data: tail };
    }

    // The content does not extend what was handed on: a deliberate replacement
    // through the codec's `update` verb, or an update by another writer. The
    // whole content is what this delivery adds, and the baseline moves to it.
    this._logger?.debug('DefaultDecoderCore.prepare(); update replaces content', {
      serial,
      priorLength: state.accumulated.length,
      length: data.length,
    });
    state.accumulated = data;
    return message;
  }

  private _delete(serial: string): void {
    // Nothing follows a delete: the platform rejects an append or update to a
    // deleted message, and history returns it as a delete.
    this._state.delete(serial);
    this._logger?.debug('DefaultDecoderCore.prepare(); message deleted, forgetting serial', { serial });
  }

  /**
   * Forget the serial a closer names. A closer for a serial the core does not
   * hold arrived before its stream: history decoded it first because the two
   * sit on different pages, or this decoder attached after the stream's last
   * write. Its serial is remembered so the stream's message, if it arrives, is
   * handed on without being tracked.
   * @param message - The delivery.
   */
  private _end(message: Ably.InboundMessage): void {
    const ended = endedSerial(message);
    if (ended === undefined) return;
    if (this._state.delete(ended)) {
      this._logger?.debug('DefaultDecoderCore.prepare(); stream ended, forgetting serial', { serial: ended });
    } else {
      this._closed.add(ended);
      this._logger?.debug('DefaultDecoderCore.prepare(); closer before its stream, remembering serial', {
        serial: ended,
      });
    }
  }

  /**
   * Whether a closer for this serial has already passed. Consumes the record:
   * the stream's message is the one delivery it exists for.
   * @param serial - The message serial.
   * @returns True when the stream has ended and must not be tracked.
   */
  private _alreadyEnded(serial: string): boolean {
    if (!this._closed.delete(serial)) return false;
    this._logger?.debug('DefaultDecoderCore.prepare(); stream already ended, not tracking', { serial });
    return true;
  }

  /**
   * Whether a delivery for a tracked serial has already been incorporated.
   * Versions of one message sort lexicographically, so a version at or below
   * the one remembered adds nothing. A version-bearing delivery that passes
   * advances the remembered version.
   * @param state - The serial's state.
   * @param message - The delivery.
   * @param serial - The message serial, for logging.
   * @returns True when the delivery must be dropped.
   */
  private _alreadyIncorporated(state: SerialState, message: Ably.InboundMessage, serial: string): boolean {
    const version = message.version.serial;
    if (version === undefined) return false;
    if (version <= state.version) {
      this._logger?.debug('DefaultDecoderCore.prepare(); delivery already incorporated, dropping', {
        serial,
        version,
        incorporated: state.version,
      });
      return true;
    }
    state.version = version;
    return false;
  }
}

/**
 * The version a delivery carries, falling back to the message serial: a
 * never-mutated message's only version is itself.
 * @param message - The delivery.
 * @param serial - The message serial.
 * @returns The version serial to remember.
 */
const versionOf = (message: Ably.InboundMessage, serial: string): string => message.version.serial ?? serial;

/**
 * Create a decoder core.
 * @param options - See {@link DecoderCoreOptions}.
 * @returns A new {@link DecoderCore}.
 */
export const createDecoderCore = (options: DecoderCoreOptions = {}): DecoderCore => new DefaultDecoderCore(options);
