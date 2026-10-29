/**
 * The read side of the chat transport: the part that reads the channel.
 *
 * A reader subscribes once, through a transport of its own with the Vercel
 * codec, and keeps the latest turn on the channel: its chunks from its
 * `start` chunk, and whether its terminal chunk has arrived. The subscription
 * first replays history back to the newest `start` chunk, so a turn that was
 * running before the reader attached is known, and from then on the reader
 * learns of turns from live delivery.
 *
 * It keeps the latest turn itself, rather than reading history again for a
 * later stream, because history only reaches back from the point where the
 * channel attached: a turn that starts after that point is only ever seen
 * live. And a transport decodes each message of a stream once while the
 * stream is open, so a second read of a stream that is still being written
 * would come back cut short.
 *
 * Streams follow the reader. A stream waiting for its turn begins at the next
 * `start` chunk, and a stream reading a turn gets each chunk of it until the
 * terminal chunk. The reader takes a turn to run from its `start` chunk to
 * the first terminal chunk after it, so:
 *
 * - Chunks of a turn that was already running when a stream started waiting,
 *   such as a stopped turn still finishing, are not that stream's.
 * - A `start` chunk that arrives while a turn is running ends the streams
 *   reading that turn, which ended without its terminal chunk.
 * - Between a turn's terminal chunk and the next `start` chunk, an `error`
 *   ends a waiting stream: its agent failed before it streamed anything.
 *   Anything else there trails the turn before, as the `finish-step` and
 *   `finish` the AI SDK writes after an `error` do.
 */

import * as Ably from '@ably/pubsub-core';
import type * as AI from 'ai';

import type { Delivery } from '../../core/codec/codec.js';
import { createTransport, type Transport, untilEvent } from '../../core/transport/index.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { VercelEvent } from '../codec/events.js';
import { vercel } from '../codec/index.js';
import { CLOSED, stoppedError } from './stopped.js';
import { isTerminal, type TurnStream } from './turn-stream.js';

/** The latest turn on the channel, as far as the reader has seen it. */
export interface LatestTurn {
  /** The serial of the turn's `start` chunk. */
  readonly startSerial: string;
  /** The turn's chunks so far, from its `start` chunk. */
  readonly chunks: readonly AI.UIMessageChunk[];
  /** Whether its terminal chunk has arrived, which ends the streams reading it. */
  readonly ended: boolean;
}

/** Options for {@link TurnReader}. */
export interface TurnReaderOptions {
  /** The client to read through. */
  client: Ably.PubSubRealtimeClient;
  /** The channel, as the chat transport resolved it. */
  channel: Ably.RealtimeChannel;
  /** The chat transport's logger. */
  logger: Logger;
}

/**
 * The close still in flight on each channel, which the next reader on it
 * waits for before it subscribes, so the earlier reader's detach cannot land
 * on the new subscription. It spans chat transports: a page that mounts a new
 * transport while the previous one is closing reads the same channel. Keyed
 * by the channel, so readers of other channels never wait on each other.
 */
const closing = new WeakMap<Ably.RealtimeChannel, Promise<void>>();

/**
 * The latest turn, as the reader keeps it. The turn owns the rule for when
 * it ends.
 */
class Turn implements LatestTurn {
  readonly startSerial: string;
  private readonly _chunks: AI.UIMessageChunk[];
  private _ended = false;
  /** Whether the turn ended with an `error` and the `finish` the AI SDK writes after one has not come yet. */
  private _inErrorTail = false;

  /**
   * Begin a turn at its `start` chunk.
   * @param startSerial - The serial of the `start` chunk.
   * @param start - The `start` chunk.
   */
  constructor(startSerial: string, start: AI.UIMessageChunk) {
    this.startSerial = startSerial;
    this._chunks = [start];
  }

  get chunks(): readonly AI.UIMessageChunk[] {
    return this._chunks;
  }

  get ended(): boolean {
    return this._ended;
  }

  /**
   * Take a chunk of the running turn. A terminal chunk ends the turn.
   * @param chunk - The chunk.
   * @returns Whether the chunk ended the turn.
   */
  add(chunk: AI.UIMessageChunk): boolean {
    this._chunks.push(chunk);
    if (!isTerminal(chunk)) return false;
    this._ended = true;
    this._inErrorTail = chunk.type === 'error';
    return true;
  }

  /**
   * Take a chunk that came after the turn ended with an `error`, up to the
   * `finish` the AI SDK writes after one: it goes on with a merged stream
   * after one of its streams fails, then writes `finish-step` and `finish`.
   * @param chunk - The chunk.
   * @returns Whether the chunk trails the turn's `error`.
   */
  takeErrorTail(chunk: AI.UIMessageChunk): boolean {
    if (!this._inErrorTail) return false;
    if (chunk.type === 'finish') this._inErrorTail = false;
    return true;
  }
}

/**
 * The chunk a delivery carries for `useChat`, if any. The codec's own
 * `user-message` is a prompt, not part of a reply, and a message the codec
 * has nothing for is the application's.
 * @param event - The decoded event.
 * @returns The chunk, or `undefined`.
 */
const chunkOf = (event: VercelEvent | undefined): AI.UIMessageChunk | undefined => {
  if (event === undefined || event.type === 'user-message') return undefined;
  // CAST: every other member is a chunk. The cross-major members are chunk
  // types the installed `ai` may lack; its reducer passes over a type it does
  // not know.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- redundant only where the installed `ai` has the cross-major chunk types
  return event as AI.UIMessageChunk;
};

/**
 * Whether a delivery carries a `start` chunk: where a turn's chunks begin.
 * @param delivery - The decoded delivery.
 * @returns True for a `start` chunk.
 */
const isStart = (delivery: Delivery<VercelEvent>): boolean => delivery.event?.type === 'start';

/**
 * Wrap a failure to read the channel in the SDK's own codes: a history
 * failure keeps its error, and anything else, such as an attach the channel
 * refused, becomes `SessionSubscriptionFailed`, with the failure as its cause.
 * @param error - The failure.
 * @returns The error to report.
 */
const wrapReadError = (error: unknown): Ably.ErrorInfo => {
  if (error instanceof Ably.ErrorInfo && errorInfoIs(error, ErrorCode.SessionHistoryFetchFailed)) return error;
  return new Ably.ErrorInfo(
    `unable to read the channel; ${errorMessage(error)}`,
    ErrorCode.SessionSubscriptionFailed,
    500,
    errorCause(error),
  );
};

/** Reads one channel for a chat transport, from when it is created until it is closed. */
export class TurnReader {
  /** Resolves once history has been read and the reader is live. Rejects when the channel could not be read, or the reader closed first. */
  readonly ready: Promise<void>;
  private readonly _client: Ably.PubSubRealtimeClient;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _followers = new Set<TurnStream>();
  private readonly _logger: Logger;
  /** Created once the previous reader on the channel has closed; see {@link TurnReader._start}. */
  private _transport: Transport<VercelEvent> | undefined;
  private _latest: Turn | undefined;
  private _closed = false;
  private _stale = false;

  /**
   * Subscribe once the channel's previous reader has closed, replaying
   * history back to the newest `start` chunk first.
   * @param options - See {@link TurnReaderOptions}.
   */
  constructor(options: TurnReaderOptions) {
    this._logger = options.logger.withContext({ component: 'TurnReader' });
    this._client = options.client;
    this._channel = options.channel;
    this.ready = this._start(closing.get(this._channel));
    // A call that never waits for the reader, such as one whose abort signal
    // had already fired, must not leave a failed open as an unhandled
    // rejection. The same promise still rejects for a caller that awaits it,
    // and `_start` has logged a failure.
    this.ready.catch(() => {
      /* rejects for a caller that awaits it; logged in _start */
    });
  }

  /**
   * The latest turn on the channel.
   * @returns The turn, or `undefined` when the reader has seen none.
   */
  get latest(): LatestTurn | undefined {
    return this._latest;
  }

  /**
   * Whether the reader can no longer serve replies. That happens when it
   * could not read the channel, or when the channel lost continuity while it
   * read it, as after a long disconnection or a detach by other code; it may
   * then have missed chunks. The next call reads the channel again with a new
   * reader.
   * @returns True once that has happened.
   */
  get stale(): boolean {
    return this._stale;
  }

  /**
   * Hand a stream the next turn to start, from its `start` chunk, until the
   * stream ends. A closed reader ends the stream with `OperationCancelled`
   * instead.
   * @param stream - The stream.
   */
  waitForNextTurn(stream: TurnStream): void {
    this._logger.trace('TurnReader.waitForNextTurn();');
    this._follow(stream);
  }

  /**
   * Hand a stream the latest turn, replaying its chunks so far from its
   * `start` chunk, then follow it live until the stream ends. When that turn
   * has already ended, the replay includes its terminal chunk, so the stream
   * ends there. A closed reader ends the stream with `OperationCancelled`
   * instead.
   * @param stream - The stream.
   */
  joinLatestTurn(stream: TurnStream): void {
    this._logger.trace('TurnReader.joinLatestTurn();');
    if (!this._closed) for (const chunk of this._latest?.chunks ?? []) stream.write(chunk);
    this._follow(stream);
  }

  /**
   * Stop handing chunks to a stream.
   * @param stream - The stream.
   */
  unfollow(stream: TurnStream): void {
    this._followers.delete(stream);
  }

  /**
   * Stop reading: end every stream still following with `OperationCancelled`,
   * and close the transport, which unsubscribes and detaches the channel once
   * the reader has subscribed, even when other code attached it first. The
   * next reader on the channel subscribes once that has finished. Idempotent,
   * and never rejects.
   * @param reason - Why the reader stops, for the error its streams end with.
   */
  async close(reason: string = CLOSED): Promise<void> {
    if (this._closed) return;
    this._logger.trace('TurnReader.close();', { reason });
    this._closed = true;
    for (const stream of this._followers) stream.fail(stoppedError('read the turn', reason));
    this._followers.clear();
    const previous = closing.get(this._channel);
    const closingNow = this._transport?.close();
    const chain = (async (): Promise<void> => {
      await previous;
      await closingNow;
    })();
    closing.set(this._channel, chain);
    await chain;
  }

  private _follow(stream: TurnStream): void {
    if (this._closed) {
      stream.fail(stoppedError('read the turn', CLOSED));
      return;
    }
    if (!stream.ended) this._followers.add(stream);
  }

  /**
   * Wait for the channel's previous reader to close, then create a transport,
   * subscribe and replay history. The transport, and with it the watch on
   * the channel's continuity, starts only now: the previous reader's detach
   * must not count as this reader losing continuity.
   * @param previous - The previous reader's close, if one is in flight.
   * @throws {Ably.ErrorInfo} `SessionHistoryFetchFailed` when history cannot be read; `SessionSubscriptionFailed`, with the cause, when the channel cannot be read otherwise, such as an attach it refused; `OperationCancelled` when the reader closed first.
   */
  private async _start(previous: Promise<void> | undefined): Promise<void> {
    // A function rather than a plain `this._closed` check: after the first
    // check TypeScript assumes the field stays false, though `close()` can
    // set it during the awaits below.
    const isClosed = (): boolean => this._closed;
    await previous;
    if (isClosed()) throw stoppedError('read the channel', CLOSED);
    if (this._channel.state === 'attached') {
      this._logger.warn('TurnReader._start(); the channel was attached before the reader, so its history starts there');
    }
    try {
      // A transport of its own, so its decoder has decoded nothing before
      // the history replay and decodes every replayed message whole.
      const transport = createTransport({
        client: this._client,
        channelName: this._channel.name,
        codec: vercel,
        logger: this._logger,
      });
      this._transport = transport;
      transport.on('discontinuity', () => {
        this._stale = true;
        // The transport has warned of the loss; this is the reader's own change.
        this._logger.debug('TurnReader._start(); stale: the next call reads the channel again');
      });
      transport.on('error', (error) => {
        this._failRunningReplies(error);
      });
      const subscription = transport.subscribe(
        (delivery) => {
          this._receive(delivery);
        },
        { history: { replay: untilEvent(isStart) } },
      );
      const { replayed } = await subscription.replayed;
      this._logger.debug('TurnReader._start(); live', {
        replayed,
        turn: this._latest === undefined ? 'none' : this._latest.ended ? 'ended' : 'running',
      });
    } catch (error) {
      if (isClosed()) throw stoppedError('read the channel', CLOSED);
      const failure = wrapReadError(error);
      this._logger.error('TurnReader._start(); unable to read the channel', { error: failure.message });
      this._stale = true;
      throw failure;
    }
  }

  /**
   * End the streams reading the running turn when a message that arrives
   * live while it runs cannot be decoded. The transport's error does not say
   * which message failed; it is most likely one of the turn's, so the reply
   * ends with the error rather than hanging or showing less than the agent
   * sent. A message replayed from history that cannot be decoded is only
   * logged, by the transport, and the reply goes on without it.
   * @param error - The transport's error.
   */
  private _failRunningReplies(error: Ably.ErrorInfo): void {
    if (!errorInfoIs(error, ErrorCode.SessionMessageProcessingFailed)) return;
    if (this._latest?.ended !== false) return;
    // The transport has logged the failure; this only ends the replies.
    this._logger.debug(
      'TurnReader._failRunningReplies(); ending the replies reading the turn: one of its messages could not be decoded',
      { turn: this._latest.startSerial },
    );
    for (const stream of this._followers) if (stream.reading) stream.fail(error);
  }

  /**
   * Take one delivery: a `start` chunk begins a turn, a chunk of the running
   * turn goes to the streams reading it, what the AI SDK writes after an
   * `error` trails that turn, and an `error` between turns ends the waiting
   * streams.
   * @param delivery - The decoded delivery.
   * @param delivery.event - The decoded event, if any.
   * @param delivery.message - The Ably message it came in.
   */
  private _receive({ event, message }: Delivery<VercelEvent>): void {
    const chunk = chunkOf(event);
    if (chunk === undefined) return;
    if (chunk.type === 'start') {
      this._startTurn(chunk, message.serial ?? '');
      return;
    }
    const latest = this._latest;
    if (latest?.ended === false) {
      if (latest.add(chunk)) {
        this._logger.debug('TurnReader._receive(); turn ended', { turn: latest.startSerial, type: chunk.type });
      }
      for (const stream of this._followers) if (stream.reading) stream.write(chunk);
      return;
    }
    if (chunk.type !== 'error') {
      if (latest?.takeErrorTail(chunk) === true) {
        this._logger.debug('TurnReader._receive(); passing over a chunk the failed turn wrote after its error', {
          serial: message.serial,
          type: chunk.type,
        });
      } else {
        // A reply ends at its terminal chunk, so a chunk outside any turn,
        // such as a data part written after `finish`, reaches no reply.
        this._logger.warn('TurnReader._receive(); passing over a chunk written outside any turn', {
          serial: message.serial,
          type: chunk.type,
        });
      }
      return;
    }
    this._logger.debug('TurnReader._receive(); error with no turn running', { serial: message.serial });
    for (const stream of this._followers) if (!stream.reading) stream.write(chunk);
  }

  /**
   * Keep a new turn from its `start` chunk, and hand that chunk to every
   * stream, which begins a waiting one. A turn still running has ended
   * without its terminal chunk, so the streams reading it end first.
   * @param start - The `start` chunk.
   * @param serial - Its serial.
   */
  private _startTurn(start: AI.UIMessageChunk, serial: string): void {
    const previous = this._latest;
    if (previous?.ended === false) {
      this._logger.warn('TurnReader._startTurn(); a turn started before the previous one ended', {
        previous: previous.startSerial,
        serial,
      });
      for (const stream of this._followers) if (stream.reading) stream.close();
    }
    this._latest = new Turn(serial, start);
    this._logger.debug('TurnReader._startTurn(); turn started', { serial });
    for (const stream of this._followers) stream.write(start);
  }
}
