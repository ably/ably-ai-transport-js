/**
 * The read side of the chat transport: the part that reads the channel.
 *
 * A reader subscribes once, with a listener and a decoder of its own, and
 * keeps the latest turn on the channel: its chunks from its `start` chunk,
 * and whether its terminal chunk has arrived. It first reads history back to
 * the newest `start` chunk, so a turn that was running before the reader
 * subscribed is known, and from then on it learns of turns from live
 * delivery.
 *
 * It keeps the latest turn itself, rather than reading history again for a
 * later stream, because history only reaches back from the point where the
 * channel attached: a turn that starts after that point is only ever seen
 * live. And while a stream is open, a decoder decodes each of its messages
 * once, so a second read through it of a stream that is still being written
 * would come back cut short.
 *
 * History and live delivery go through the one decoder, history first. What
 * arrives live while history is read is held and decoded once history has
 * been, so the decoder sees every stream in the order it was written.
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
import type { Decoder } from '../../core/decoder/index.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { VercelEvent } from '../codec/events.js';
import { vercelDecoder } from '../decoder.js';
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
  /** The channel, as the application handed it to the chat transport. */
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
 * Whether a channel state change means the reader may have missed messages:
 * FAILED, SUSPENDED or DETACHED, where no more arrive, or ATTACHED with
 * `resumed: false`, an UPDATE included, where some were lost.
 * @param stateChange - The state change.
 * @returns True when continuity was lost.
 */
const isContinuityLost = (stateChange: Ably.ChannelStateChange): boolean => {
  const { current, resumed } = stateChange;
  return (
    current === 'failed' || current === 'suspended' || current === 'detached' || (current === 'attached' && !resumed)
  );
};

/**
 * Wrap a failure to read the channel, such as an attach the channel refused
 * or a history page that could not be fetched. The wrapped error keeps the
 * failure's code and status, `InternalError` when it has no code, and
 * carries the failure as its cause. ably-js rejects some reads with a
 * `PartialErrorInfo`, such as a history request that timed out, and an
 * `ErrorInfo` takes only an `ErrorInfo` as its cause, so such a failure is
 * carried as one.
 * @param error - The failure.
 * @returns The error to report.
 */
const wrapReadError = (error: unknown): Ably.ErrorInfo => {
  const cause =
    error instanceof Ably.PartialErrorInfo
      ? new Ably.ErrorInfo(
          error.message,
          error.code ?? ErrorCode.InternalError,
          error.statusCode ?? 500,
          errorCause(error.cause),
        )
      : errorCause(error);
  return new Ably.ErrorInfo(
    `unable to read the channel; ${errorMessage(error)}`,
    cause?.code ?? ErrorCode.InternalError,
    cause?.statusCode ?? 500,
    cause,
  );
};

/** Reads one channel for a chat transport, from when it is created until it is closed. */
export class TurnReader {
  /** Resolves once history has been read and the reader is live. Rejects when the channel could not be read, or the reader closed first. */
  readonly ready: Promise<void>;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _decoder: Decoder<VercelEvent>;
  private readonly _followers = new Set<TurnStream>();
  private readonly _logger: Logger;
  /** What arrived live while history was read, in arrival order; `undefined` once the reader is live. */
  private _held: Ably.InboundMessage[] | undefined = [];
  private _latest: Turn | undefined;
  private _closed = false;
  private _stale = false;
  /** Whether this reader's own read attached the channel, so closing it detaches the channel again. */
  private _attachedChannel = false;
  /** Whether the channel has reached ATTACHED since the reader began watching it. */
  private _attachedSinceWatching = false;

  /**
   * Subscribe once the channel's previous reader has closed, reading history
   * back to the newest `start` chunk first.
   * @param options - See {@link TurnReaderOptions}.
   */
  constructor(options: TurnReaderOptions) {
    this._logger = options.logger.withContext({ component: 'TurnReader' });
    this._channel = options.channel;
    // A decoder of its own, so it has decoded nothing before this reader's
    // history read, and decodes every message it reads whole.
    this._decoder = vercelDecoder({ logger: this._logger });
    this._decoder.onError((error) => {
      this._failRunningReplies(error);
    });
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
   * unsubscribe, and detach the channel when this reader's own read attached
   * it, so the next reader attaches it again and reads history from there.
   * The next reader on the channel subscribes once that has finished.
   * Idempotent, and never rejects.
   * @param reason - Why the reader stops, for the error its streams end with.
   */
  async close(reason: string = CLOSED): Promise<void> {
    if (this._closed) return;
    this._logger.trace('TurnReader.close();', { reason });
    this._closed = true;
    for (const stream of this._followers) stream.fail(stoppedError('read the turn', reason));
    this._followers.clear();
    const previous = closing.get(this._channel);
    const chain = (async (): Promise<void> => {
      await previous;
      await this._release();
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
   * Wait for the channel's previous reader to close, then watch the channel,
   * subscribe, attach it and read history. The watch on the channel's
   * continuity starts only now: the previous reader's detach must not count
   * as this reader losing continuity.
   * @param previous - The previous reader's close, if one is in flight.
   * @throws {Ably.ErrorInfo} The failure, wrapped with its own code and as the cause, when the channel cannot be attached or its history read; `OperationCancelled` when the reader closed first.
   */
  private async _start(previous: Promise<void> | undefined): Promise<void> {
    // A function rather than a plain `this._closed` check: after the first
    // check TypeScript assumes the field stays false, though `close()` can
    // set it during the awaits below.
    const isClosed = (): boolean => this._closed;
    await previous;
    if (isClosed()) throw stoppedError('read the channel', CLOSED);
    const channel = this._channel;
    const { state } = channel;
    if (state === 'attached') {
      this._logger.warn('TurnReader._start(); the channel was attached before the reader, so its history starts there');
    }
    // Only a channel nothing has attached is this reader's to attach, and so
    // to detach again. One that is ATTACHING or ATTACHED, or SUSPENDED or
    // FAILED after an attach, is the application's: ably-js re-attaches a
    // SUSPENDED channel by itself once the connection is back.
    this._attachedChannel = state === 'initialized' || state === 'detaching' || state === 'detached';
    this._attachedSinceWatching = state === 'attached';
    channel.on(this._onStateChange);
    try {
      await channel.subscribe(this._listener);
      // A close during the subscribe has already let the channel go, so
      // attaching it now would leave it attached with no listener.
      if (isClosed()) throw stoppedError('read the channel', CLOSED);
      // Subscribing attaches the channel unless the application turned that
      // off, as `<ChannelProvider>` does, and history needs it attached.
      await channel.attach();
      const replayed = await this._readHistory(isClosed);
      for (const delivery of replayed) this._receive(delivery);
      const held = this._held ?? [];
      this._held = undefined;
      for (const message of held) this._take(message);
      this._logger.debug('TurnReader._start(); live', {
        replayed: replayed.length,
        held: held.length,
        turn: this._latest === undefined ? 'none' : this._latest.ended ? 'ended' : 'running',
      });
    } catch (error) {
      this._held = undefined;
      if (isClosed()) throw stoppedError('read the channel', CLOSED);
      const failure = wrapReadError(error);
      this._logger.error('TurnReader._start(); unable to read the channel', { error: failure.message });
      this._stale = true;
      channel.unsubscribe(this._listener);
      throw failure;
    }
  }

  /**
   * Read history back from where the channel attached to the newest `start`
   * chunk, decoding each message on the way, newest first.
   * @param isClosed - Whether the reader has closed since the read began.
   * @returns The deliveries from the newest `start` chunk on, oldest first; every delivery in history when it holds no `start` chunk.
   * @throws {Ably.ErrorInfo} `OperationCancelled` when the reader closed during the read; whatever `history` or a page's `next` rejected with otherwise.
   */
  private async _readHistory(isClosed: () => boolean): Promise<Delivery<VercelEvent>[]> {
    // One entry per message, newest first, each holding the message's
    // deliveries in the order the decoder returned them.
    const newestFirst: Delivery<VercelEvent>[][] = [];
    let page = await this._channel.history({ untilAttach: true });
    for (;;) {
      if (isClosed()) throw stoppedError('read the channel', CLOSED);
      for (const message of page.items) {
        const deliveries = this._decoder.decode(message);
        newestFirst.push(deliveries);
        if (deliveries.some((delivery) => isStart(delivery))) return newestFirst.toReversed().flat();
      }
      if (!page.hasNext()) break;
      const next = await page.next();
      if (next === null) break;
      page = next;
    }
    return newestFirst.toReversed().flat();
  }

  /**
   * Take each message the channel delivers: held while history is read, then
   * decoded as it arrives. Bound once, so `close()` unsubscribes the same
   * listener.
   * @param message - The message.
   */
  private readonly _listener = (message: Ably.InboundMessage): void => {
    if (this._closed) return;
    if (this._held === undefined) this._take(message);
    else this._held.push(message);
  };

  /**
   * Mark the reader stale once the channel loses continuity after it attached.
   * State changes before that are the channel coming up. Bound once, so
   * `close()` removes the same listener.
   * @param stateChange - The channel's state change.
   */
  private readonly _onStateChange = (stateChange: Ably.ChannelStateChange): void => {
    if (this._closed) return;
    if (!this._attachedSinceWatching) {
      if (stateChange.current === 'attached') this._attachedSinceWatching = true;
      return;
    }
    if (this._stale || !isContinuityLost(stateChange)) return;
    this._stale = true;
    this._logger.warn('TurnReader._onStateChange(); the channel lost continuity, so the next call reads it again', {
      current: stateChange.current,
      resumed: stateChange.resumed,
    });
  };

  /**
   * Stop listening to the channel, and detach it when this reader's own read
   * attached it. Best effort: the reader is closing, and nothing is left to
   * retry, so a detach that fails is only logged.
   */
  private async _release(): Promise<void> {
    this._channel.off(this._onStateChange);
    this._channel.unsubscribe(this._listener);
    if (!this._attachedChannel) return;
    try {
      await this._channel.detach();
    } catch (error) {
      this._logger.debug('TurnReader._release(); unable to detach the channel', { error: errorMessage(error) });
    }
  }

  /**
   * Decode one message that arrived live, and take each delivery.
   * @param message - The message.
   */
  private _take(message: Ably.InboundMessage): void {
    for (const delivery of this._decoder.decode(message)) this._receive(delivery);
  }

  /**
   * End the streams reading the running turn when a message that arrives
   * live while it runs cannot be decoded. The decoder's error does not say
   * which message failed; it is most likely one of the turn's, so the reply
   * ends with the error rather than hanging or showing less than the agent
   * sent. No reply reads a turn before the reader is live, so a message read
   * from history that cannot be decoded is only logged, by the decoder, and a
   * reply that rejoins the turn goes on without it.
   * @param error - The decoder's error.
   */
  private _failRunningReplies(error: Ably.ErrorInfo): void {
    if (this._latest?.ended !== false) return;
    // The decoder has logged the failure; this only ends the replies.
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
