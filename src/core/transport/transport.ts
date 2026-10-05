/**
 * The transport: one channel on an Ably Realtime client, and one codec.
 *
 * The transport resolves the channel by name off the client it is given,
 * stamping the SDK's attribution on it and the modes the caller asked for. It
 * owns that channel: `close` detaches it when the transport attached it. The
 * caller owns the client's lifecycle, and `close` never closes it.
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
 * itself. A subscribe that asks for `history` immediately buffers live
 * messages for its handler, until the history replay is exhausted. A replay
 * function reads the channel's history back to the point it chooses. The
 * transport replays what the function returned, in channel order, then releases
 * the buffered messages in arrival order, so the handler sees history before
 * live, in channel order. The transport reports a channel state change that
 * breaks continuity as a discontinuity, and the application recovers by
 * subscribing again with `fromSerial` at the last position it applied.
 *
 * `history` reads backwards from the attach point through the same codec, so
 * a message that history and live delivery both carry decodes once. It
 * returns the page a replay function receives.
 *
 * `close` stops every pipe in flight, unsubscribes the listener and settles.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import { registerAgent } from '../agent.js';
import { transportChannelOptions } from '../channel-options.js';
import type { Codec, Delivery } from '../codec/codec.js';
import {
  bestEffortDetach,
  closedError,
  ContinuityWatcher,
  subscribeAndAttach,
  wrapMessageProcessingError,
} from './channel-support.js';
import { type MessageHeaders, prepareHeaders, withHeaders } from './headers.js';
import { type HistoryOptions, type HistoryPage, openHistoryWalk } from './history-pager.js';
import { type PipeResult, type PipeSource, pipeStream } from './pipe-stream.js';
import { createPipeWriter } from './pipe-writer.js';
import {
  positionOf,
  type Replay,
  type ReplayResult,
  type SubscribeHistory,
  type SubscribeOptions,
  type Subscription,
} from './replay.js';

/**
 * Options for {@link createTransport}.
 * @template E - The codec's event union.
 */
export interface TransportOptions<E> {
  /** The Ably Realtime client to resolve the channel from. The caller owns its lifecycle: `close()` never closes it. */
  client: Ably.Realtime;
  /** The name of the channel to publish on and receive from. The transport resolves it and owns its options, so an application that wants the same channel elsewhere asks for it by name with no options. */
  channelName: string;
  /** The codec that turns events into Ably messages and back. */
  codec: Codec<E>;
  /** Channel modes to request on top of the server default set, for example `OBJECT_MODES`. Omit to attach with no mode flags, which the server answers with its default set. Two transports sharing one client and channel name share the channel, so they must ask for the same modes. */
  channelModes?: readonly Ably.ChannelMode[];
  /** Whether the channel delivers this connection's own publishes back to it. `true` by default, the platform's own behaviour, so a publisher sees its own message as an ordinary delivery. Set `false` to render what you sent from the event you sent and reconcile on the serial `send` returned. */
  echoMessages?: boolean;
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
   *
   * With `history`, the transport immediately buffers live messages for this
   * handler, until the history replay is exhausted. It pages history back
   * from the attach point and gives the newest page to `history.replay`. It
   * delivers what the function returned to the handler first, in channel order,
   * then the buffered messages in arrival order. From then on the handler is
   * live. The transport does not buffer the other handlers. One history replay runs
   * at a time on a transport, so a second subscribe with `history` waits for
   * the first to finish. An unsubscribe during the history replay stops it and drops
   * the buffered messages.
   * @param handler - Called with each delivery, in channel order.
   * @param options - The history to replay first; see {@link SubscribeOptions}.
   * @returns The unsubscribe: stops delivering to this handler. The channel listener stays registered for the transport's other handlers until `close()`. Its `replayed` resolves with the history replay's result once the handler is live, and rejects when the replay failed; see {@link Subscription}.
   * @throws {Ably.ErrorInfo} `SessionClosed` after `close()`; `InvalidArgument` when `history.pageSize` is less than one.
   */
  subscribe(handler: (delivery: Delivery<E>) => void, options?: SubscribeOptions<E>): Subscription;
  /**
   * Read channel history backwards from the attach point, decoded through the
   * codec. Each call pages again from the channel's current attach point
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
   * subscribes again with `history: { replay: fromSerial(position) }`, where
   * `position` is the last one it applied (a result's `serial`, or the
   * newest `version.serial ?? serial` its handler has seen); the codec returns
   * a stream message the handler already saw with no event.
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
   * listener, then detach the channel if `subscribe` or `history` attached
   * it. The transport resolved the channel, so it owns the detach, and a
   * transport sharing the channel's name on the same client shares that
   * channel and sees it detach. The detach is best effort: a failure is
   * logged and swallowed. The client stays connected, since the caller owns
   * it. Never rejects. Later calls on the transport throw `SessionClosed`.
   * Idempotent.
   */
  close(): Promise<void>;
}

interface InFlightPipe {
  controller: AbortController;
  done: Promise<unknown>;
}

/** One subscribed handler, with the state a history replay keeps for it. */
interface HandlerEntry<E> {
  handler: (delivery: Delivery<E>) => void;
  /** The live deliveries buffered while history is replayed; `undefined` once the handler is live. */
  buffered: Delivery<E>[] | undefined;
  /** Fires on unsubscribe, to stop a history replay in flight. */
  abort: AbortController;
  /** The newest position the handler has been called with; see {@link positionOf}. */
  position: string | undefined;
}

interface TransportEvents {
  discontinuity: undefined;
  error: Ably.ErrorInfo;
}

/** The result of a subscription without `history`. */
const NO_REPLAY: ReplayResult = { replayed: 0, serial: undefined };

/**
 * The deliveries and verdict a replay function returned, whichever shape it
 * chose.
 * @param returned - The function's return value.
 * @returns It as a {@link Replay}.
 */
const toReplay = <E>(returned: Delivery<E>[] | Replay<E>): Replay<E> =>
  Array.isArray(returned) ? { deliveries: returned } : returned;

/**
 * Wrap a failure of a history replay. A page fetch and a replay builder already
 * throw `Ably.ErrorInfo`. A replay function the application wrote may throw
 * anything, and the transport reports that under the history code, with the
 * thrown value's message in its own.
 * @param error - The thrown value.
 * @returns The error to report.
 */
const wrapReplayError = (error: unknown): Ably.ErrorInfo =>
  error instanceof Ably.ErrorInfo
    ? error
    : new Ably.ErrorInfo(
        `unable to replay history; replay function threw: ${errorMessage(error)}`,
        ErrorCode.SessionHistoryFetchFailed,
        500,
      );

/**
 * The deliveries a replay function returned, in channel order. History holds
 * messages in creation order, so a stable sort on the creation serial puts
 * the deliveries back in that order whatever order the function returned
 * them in, and the deliveries of one message keep the order the codec
 * decoded them in.
 * @param returned - What the function returned.
 * @returns The same deliveries, oldest first.
 */
const inChannelOrder = <E>(returned: Delivery<E>[]): Delivery<E>[] =>
  returned.toSorted((a, b) => {
    const left = a.message.serial ?? '';
    const right = b.message.serial ?? '';
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });

/**
 * Resolve the transport's channel off the client, and register the SDK's
 * agent entries on the client so the connection it opens is attributed too.
 *
 * The options come from `transportChannelOptions`, the one place that builds
 * them, so the React provider's `<ChannelProvider>` can hand ably-js the same
 * ones. ably-js keeps one channel per name, so a name already resolved with
 * different params or modes while the channel is attaching or attached is
 * rejected by `channels.get` rather than silently reattached; that rejection
 * reaches the caller as the cause.
 * @param options - The transport's options.
 * @param logger - Logger for the resolution and its failure.
 * @returns The channel.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when `channelName` is empty; the wrapped `channels.get` failure otherwise.
 */
const resolveChannel = <E>(options: TransportOptions<E>, logger: Logger): Ably.RealtimeChannel => {
  if (options.channelName === '') {
    logger.error('Transport(); channel name is empty');
    throw new Ably.ErrorInfo(
      'unable to create transport; channelName must be a non-empty string',
      ErrorCode.InvalidArgument,
      400,
    );
  }
  const channelOptions = transportChannelOptions(options);
  registerAgent(options.client, options.codec);
  try {
    const channel = options.client.channels.get(options.channelName, channelOptions);
    logger.debug('Transport(); resolved channel', { channel: channel.name, modes: channelOptions.modes });
    return channel;
  } catch (error) {
    const cause = errorCause(error);
    const wrapped = new Ably.ErrorInfo(
      `unable to create transport; ${errorMessage(error)}`,
      cause?.code ?? ErrorCode.InternalError,
      cause?.statusCode ?? 500,
      cause,
    );
    logger.error('Transport(); channel resolution failed', {
      channel: options.channelName,
      error: wrapped.message,
    });
    throw wrapped;
  }
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
    isPermission ? ErrorCode.InsufficientCapability : ErrorCode.SessionSendFailed,
    isPermission ? 401 : 500,
    cause,
  );
};

class DefaultTransport<E> implements Transport<E> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<E>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<TransportEvents>;
  private readonly _pipes = new Set<InFlightPipe>();
  /** The subscribed handlers, in registration order. */
  private readonly _handlers = new Set<HandlerEntry<E>>();
  /** The channel listener, one bound reference so `close()` unsubscribes the same one. */
  private readonly _listener: (message: Ably.InboundMessage) => void;
  private readonly _continuity: ContinuityWatcher;
  /** Tail of the chain of history replays run for subscriptions: a settled or in-flight void promise. */
  private _readTail: Promise<void> = Promise.resolve();
  /** Whether the channel listener is registered and the attach is in flight or done. Cleared when the attach fails, so the next `subscribe` retries. */
  private _attached = false;
  /** Whether `subscribe` or `history` ever asked the channel to attach, so `close()` knows to detach it. */
  private _attachAttempted = false;
  private _closed = false;

  constructor(options: TransportOptions<E>) {
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'Transport',
    });
    this._channel = resolveChannel(options, this._logger);
    this._codec = options.codec;
    this._emitter = new EventEmitter<TransportEvents>(this._logger);
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

  subscribe(handler: (delivery: Delivery<E>) => void, options?: SubscribeOptions<E>): Subscription {
    const history = options?.history;
    this._logger.trace('Transport.subscribe();', { history: history !== undefined, pageSize: history?.pageSize });
    if (this._closed) throw closedError('subscribe');
    if (history?.pageSize !== undefined && history.pageSize < 1) {
      throw new Ably.ErrorInfo(
        'unable to subscribe; history.pageSize must be at least 1',
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const entry: HandlerEntry<E> = {
      handler,
      buffered: history === undefined ? undefined : [],
      abort: new AbortController(),
      position: undefined,
    };
    this._handlers.add(entry);
    this._attach();
    const replayed = history === undefined ? Promise.resolve(NO_REPLAY) : this._replayHistory(entry, history);
    // A subscription nobody awaits must not surface a failed replay as an
    // unhandled rejection. The same promise still rejects for a caller that
    // awaits it, and `_replayHistory` has logged the failure.
    replayed.catch(() => {
      /* rejects for a caller that awaits it; logged in _replayHistory */
    });
    const unsubscribe = (): void => {
      entry.abort.abort();
      this._handlers.delete(entry);
    };
    return Object.assign(unsubscribe, { replayed });
  }

  /**
   * Replay history to one handler, then release what arrived live meanwhile.
   * One history replay runs at a time on the transport: this one links behind the
   * tail, as a page's own `next()` calls do. The transport releases the
   * buffered deliveries whether the replay succeeded or not, so a failed
   * history replay leaves the handler live, with a gap.
   * @param entry - The handler to replay history to.
   * @param history - What to replay.
   * @returns The result, once the handler is live.
   * @throws {Ably.ErrorInfo} `SessionHistoryFetchFailed` when a page could not be fetched or the replay function threw; `OperationCancelled` when the subscription was removed, or the transport closed, during the replay.
   */
  private async _replayHistory(entry: HandlerEntry<E>, history: SubscribeHistory<E>): Promise<ReplayResult> {
    const { signal } = entry.abort;
    // `aborted()` reads the flag each time, because it flips across the awaits below.
    const aborted = (): boolean => signal.aborted;
    let replayed = 0;
    let found: boolean | undefined;
    let failure: Ably.ErrorInfo | undefined;
    const prev = this._readTail;
    const run = (async (): Promise<void> => {
      await prev;
      if (aborted()) return;
      const first = await openHistoryWalk({
        channel: this._channel,
        limit: history.pageSize ?? 100,
        toDeliveries: (message) => this._toDeliveries(message),
        signal,
        logger: this._logger,
      });
      const replay = toReplay(await history.replay(first));
      found = replay.found;
      if (aborted()) return;
      const ordered = inChannelOrder(replay.deliveries);
      for (const delivery of ordered) this._call(entry, delivery);
      replayed = ordered.length;
      this._logger.debug('Transport.subscribe(); history replayed', { replayed, found });
    })();
    this._readTail = (async (): Promise<void> => {
      try {
        await run;
      } catch {
        /* reported to the subscription through its replayed */
      }
    })();
    try {
      await run;
    } catch (error) {
      failure = wrapReplayError(error);
      this._logger.error('Transport.subscribe(); history replay failed, handler is live with a gap', {
        error: failure.message,
      });
    } finally {
      const buffered = entry.buffered ?? [];
      entry.buffered = undefined;
      if (!aborted()) for (const delivery of buffered) this._call(entry, delivery);
    }
    if (aborted()) {
      failure ??= new Ably.ErrorInfo(
        'unable to replay history; unsubscribed during the replay',
        ErrorCode.OperationCancelled,
        400,
      );
    }
    if (failure !== undefined) throw failure;
    return { replayed, serial: entry.position, found };
  }

  /**
   * Call one handler with one delivery, log a throw so the other handlers still
   * run, and record the position the handler has reached.
   * @param entry - The handler.
   * @param delivery - The delivery.
   */
  private _call(entry: HandlerEntry<E>, delivery: Delivery<E>): void {
    const position = positionOf(delivery);
    if (entry.position === undefined || position > entry.position) entry.position = position;
    try {
      entry.handler(delivery);
    } catch (error) {
      this._logger.error('Transport; handler threw', { serial: delivery.message.serial, error: errorMessage(error) });
    }
  }

  async history(options: HistoryOptions): Promise<HistoryPage<E>> {
    this._logger.trace('Transport.history();', { limit: options.limit });
    if (this._closed) throw closedError('history');
    // `history()` attaches the channel to find its attach point.
    this._attachAttempted = true;
    return openHistoryWalk({
      channel: this._channel,
      limit: options.limit,
      toDeliveries: (message) => this._toDeliveries(message),
      logger: this._logger,
    });
  }

  on(event: 'discontinuity', handler: () => void): () => void;
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;
  on<K extends 'discontinuity' | 'error'>(event: K, handler: (arg: TransportEvents[K]) => void): () => void {
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
    // A history replay in flight stops at its next page; its `replayed`
    // carries OperationCancelled.
    for (const entry of this._handlers) entry.abort.abort();
    this._handlers.clear();
    for (const pipe of this._pipes) pipe.controller.abort();
    // Each pipe rejects OperationCancelled to its own caller once it has
    // flushed and repaired; allSettled waits for that without rethrowing it here.
    await Promise.allSettled([...this._pipes].map(async (pipe) => pipe.done));
    // Detach only after the pipes settle: a pipe flushes and repairs on this
    // channel before it rejects.
    await bestEffortDetach(this._channel, this._attachAttempted, this._logger, 'Transport');
  }

  /**
   * Register the channel listener and attach, once. A failed attach is reported
   * on the error stream and forgotten, so the next `subscribe` retries against
   * a channel that may have recovered.
   */
  private _attach(): void {
    if (this._attached) return;
    this._attached = true;
    this._attachAttempted = true;
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
    // Decoded once, then fanned out: a handler whose history is replaying buffers the
    // deliveries, and the transport calls every other handler now.
    const deliveries = this._toDeliveries(message);
    for (const entry of this._handlers) {
      for (const delivery of deliveries) {
        if (entry.buffered === undefined) this._call(entry, delivery);
        else entry.buffered.push(delivery);
      }
    }
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
 * Create a transport over a codec and one channel of an Ably Realtime client.
 *
 * The channel is resolved at construction, so a name already resolved
 * elsewhere with modes that differ from these is rejected here rather than
 * changing the channel under whoever holds it.
 * @param options - See {@link TransportOptions}.
 * @returns The transport.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when `channelName` is empty; the failure `channels.get` raised, wrapped, when the channel cannot be resolved.
 */
export const createTransport = <E>(options: TransportOptions<E>): Transport<E> => new DefaultTransport(options);
