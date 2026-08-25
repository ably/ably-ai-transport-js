/**
 * The self-contained client transport: publish, receive, and history over one
 * channel and codec.
 *
 * {@link createClientTransport} owns its whole receive path: it mints a codec
 * decoder, wraps it in a receive transport, and — once {@link
 * ClientTransport.connect} subscribes and attaches — merges every inbound wire
 * message through it (`deliverEvent`, then `deliverAblyMessage`), so a
 * consumer subscribes to the transport directly instead of wiring a receiver
 * and channel listener by hand.
 *
 * On the send side, `publishInput` stamps the transport-tier headers a `user`
 * input carries (`buildTransportHeaders`) and publishes the event through the
 * codec's encoder; the sender's own input reaches it back as the ordinary
 * channel delivery, like any other subscriber's. `cancel` publishes a
 * stateless `ai-cancel` envelope for a run the caller names. `steer` publishes
 * a steering input into an open run through the {@link SteerCoordinator},
 * which resolves `published` from the publish acknowledgement's serial,
 * accumulates the `steer-transport-message-ids` stamps the agent puts on the
 * run's outputs, and resolves each steer's `outcome` by id membership at the
 * run's next lifecycle bracket. A channel state listener drains in-flight
 * steers on continuity loss — post-loss the channel will not deliver the
 * lifecycle events that would resolve them.
 *
 * `history` pages the channel backwards from the attach point and returns each
 * older slice as a batch of classified events — decoded on the same decoder as
 * the live stream, so a stream spanning the attach boundary is never
 * double-decoded.
 *
 * The transport holds no run registry: a consumer keys its own send on the
 * returned `transportMessageId` and sources a cancel's or steer's `runId` from
 * `publishInput`'s returned `runId` promise (resolved from the first
 * `ai-run-start` whose `input-transport-message-id` matches the publish) or from
 * the receive stream's run-lifecycle events.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { Decoder, WireCodec } from '../codec/types.js';
import { buildCancelMessage } from './cancel-envelope.js';
import { ConnectGuard, continuityLostError, isContinuityLost, subscribeAndAttach } from './channel-support.js';
import { buildTransportHeaders } from './headers.js';
import { DEFAULT_HISTORY_PAGE_SIZE, HistoryPager } from './history-pager.js';
import { createReceiveTransport, forwardReceiverOn, type ReceiveTransport } from './receive-transport.js';
import { SteerCoordinator } from './steer-coordinator.js';
import type { SteerResult } from './types/steer.js';
import type {
  ClientTransport,
  PublishInputOptions,
  PublishInputResult,
  TransportEvent,
  TransportHistoryOptions,
  TransportHistoryResult,
  TransportReceiver,
} from './types/transport.js';

/**
 * Options for {@link createClientTransport}.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface ClientTransportOptions<TInput, TOutput> {
  /** The Ably channel to publish on and receive from. The transport subscribes its own listener on `connect()`; the channel itself stays caller-owned (never detached). */
  channel: Ably.RealtimeChannel;
  /** The wire tier of the codec: its encoder serializes inputs to the wire and its decoder classifies inbound messages. */
  codec: WireCodec<TInput, TOutput>;
  /** The publishing client's Ably `clientId`, stamped as `run-client-id` on inputs. When omitted (anonymous), the header is not stamped and a receiver reads `WireMeta.clientId` as `undefined`. */
  clientId?: string;
  /** Wire-message limit per `channel.history()` round trip in {@link ClientTransport.history}. Defaults to 100. */
  historyPageSize?: number;
  /** Optional logger for diagnostics. */
  logger?: Logger;
}

/** The unwatch for a publish that registered no runId watch. */
const noopUnwatch = (): void => {
  /* nothing to deregister */
};

/**
 * Merge user-provided headers into an outgoing Ably message's own
 * `extras.headers` slot, outside the SDK's `extras.ai` envelope so they can
 * never collide with the transport or codec tiers.
 * @param msg - The outgoing Ably message to stamp, mutated in place.
 * @param userHeaders - The user headers to merge in.
 */
const stampUserHeaders = (msg: Ably.Message, userHeaders: Record<string, string>): void => {
  // CAST: the Ably SDK types `extras` as `any`; read defensively then rewrite.
  const existing = msg.extras as unknown;
  const base = existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {};
  const priorHeaders = base.headers;
  const headers = priorHeaders && typeof priorHeaders === 'object' ? (priorHeaders as Record<string, string>) : {};
  msg.extras = { ...base, headers: { ...headers, ...userHeaders } };
};

/** Default {@link ClientTransport}. See the file header for the composition. */
class DefaultClientTransport<TInput, TOutput> implements ClientTransport<TInput, TOutput> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: WireCodec<TInput, TOutput>;
  private readonly _clientId: string | undefined;
  private readonly _historyPageSize: number;
  private readonly _logger: Logger;
  /** The one decoder shared by the live merge and the history scan, so a stream spanning the attach boundary is never double-decoded. */
  private readonly _decoder: Decoder<TInput, TOutput>;
  private readonly _receiver: ReceiveTransport<TInput, TOutput>;
  /** The public `on`, forwarding to the receiver via the shared dispatch. */
  readonly on: TransportReceiver<TInput, TOutput>['on'];
  private readonly _connectGuard = new ConnectGuard();
  /** The channel listener — one bound reference so `close()` can unsubscribe it. */
  private readonly _onMessage: (message: Ably.InboundMessage) => void;
  /** The steer ledger behind {@link steer} — see the file header for its wiring. */
  private readonly _steer: SteerCoordinator<TInput>;
  /**
   * Pending {@link PublishInputResult.runId} watches, keyed by the publish's
   * transport-message-id. An array per key: repeat publishes under one pinned id
   * each get their own promise, all resolved by the same run-start. Entries
   * resolve on the first matching `ai-run-start` and reject on `close()` or
   * continuity loss; an input that triggers no run leaves its watch pending
   * until then.
   */
  private readonly _runIdWatches = new Map<
    string,
    { resolve: (runId: string) => void; reject: (err: Ably.ErrorInfo) => void }[]
  >();
  /** The channel state listener — one bound reference so `close()` can remove it. */
  private readonly _onChannelStateChange: Ably.channelEventCallback;
  /**
   * Whether the channel has attached at least once. Before that there is no
   * continuity to lose, so state changes are ignored (recording the initial
   * attach when it arrives). Seeded from the channel's current state so a
   * pre-attached channel is handled correctly.
   */
  private _hasAttachedOnce: boolean;
  private _closed = false;
  /** The lazily opened, single-flight history pager behind {@link history}. Decode failures surface on the receive stream's `error`, matching the live merge. */
  private readonly _historyPager: HistoryPager<TInput, TOutput>;

  constructor(options: ClientTransportOptions<TInput, TOutput>) {
    this._channel = options.channel;
    this._codec = options.codec;
    this._clientId = options.clientId;
    this._historyPageSize = options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ClientTransport',
    });
    this._decoder = this._codec.createDecoder();
    this._receiver = createReceiveTransport<TInput, TOutput>(this._decoder, this._logger);
    this.on = forwardReceiverOn(this._receiver);
    this._historyPager = new HistoryPager({
      channel: this._channel,
      pageSize: this._historyPageSize,
      decoder: this._decoder,
      logger: this._logger,
      onDecodeError: (err) => {
        this._receiver.emitError(err);
      },
    });
    this._onMessage = (message: Ably.InboundMessage) => {
      if (this._closed) return;
      // A failed decode drops the message (the receiver emitted `error`); its
      // raw `ably-message` is not emitted either, so subscribers never see a
      // wire whose typed event never fired.
      const delivery = this._receiver.deliverEvent(message);
      if (delivery.outcome === 'failed') return;
      if (delivery.outcome === 'classified') this._resolveRunIdWatches(delivery.event);
      this._receiver.deliverAblyMessage(message);
      // Feed the steer ledger every delivered message: it matches steer echoes
      // (for the publish serial), accumulates `steer-transport-message-ids`
      // stamps, and resolves steer outcomes on run-suspend / run-end.
      this._steer.observeMessage(message);
    };
    this._steer = new SteerCoordinator<TInput>({
      publish: async (input, opts) => {
        const encoder = this._codec.createEncoder(this._channel);
        try {
          return await encoder.publishInput(input, opts);
        } finally {
          await encoder.close();
        }
      },
      clientId: () => this._clientId,
      isTransportClosed: () => this._closed,
      logger: this._logger,
    });
    this._hasAttachedOnce = this._channel.state === 'attached';
    this._onChannelStateChange = (stateChange: Ably.ChannelStateChange) => {
      this._handleChannelStateChange(stateChange);
    };
    this._channel.on(this._onChannelStateChange);
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- preserve reference equality across calls
  connect(): Promise<void> {
    if (this._closed) {
      return Promise.reject(this._closedError('connect'));
    }
    this._logger.trace('ClientTransport.connect();');
    return this._connectGuard.connect(async () =>
      subscribeAndAttach(this._channel, this._onMessage, this._logger, 'ClientTransport', (error) => {
        this._receiver.emitError(error);
      }),
    );
  }

  subscribe(handler: (event: TransportEvent<TInput, TOutput>) => void): () => void {
    return this._receiver.on('event', handler);
  }

  async publishInput(event: TInput, opts?: PublishInputOptions): Promise<PublishInputResult> {
    this._logger.trace('ClientTransport.publishInput();');
    await this._requireOpen('publishInput');

    // transport-message-id: the explicit option (an input amending an existing
    // message), or a fresh id. The options are the one source of addressing —
    // the input body carries none.
    const transportMessageId = opts?.transportMessageId ?? crypto.randomUUID();
    const eventId = crypto.randomUUID();

    const headers = buildTransportHeaders({
      role: 'user',
      runId: opts?.runId,
      transportMessageId,
      runClientId: this._clientId,
      inputEventId: eventId,
    });

    const userHeaders = opts?.headers;

    const encoder = this._codec.createEncoder(
      this._channel,
      userHeaders
        ? {
            onAblyMessage: (msg) => {
              stampUserHeaders(msg, userHeaders);
            },
          }
        : undefined,
    );
    // The run's id: a continuation already names it in the options, so it
    // resolves immediately — an addressed run answers with `ai-run-resume`,
    // which carries no input-transport-message-id for a watch to match. A fresh
    // publish watches for the `ai-run-start` that will name it. Watch before
    // the publish so a run-start racing the publish's own ack can never slip
    // past; a failed publish removes the watch again.
    const { runId, unwatch } =
      opts?.runId === undefined
        ? this._watchRunId(transportMessageId)
        : { runId: Promise.resolve(opts.runId), unwatch: noopUnwatch };
    try {
      await encoder.publishInput(event, { extras: { headers }, messageId: transportMessageId });
    } catch (error) {
      unwatch();
      const cause = errorCause(error);
      const isPermission = cause?.statusCode === 401 || cause?.statusCode === 403;
      throw new Ably.ErrorInfo(
        isPermission
          ? 'unable to publish input; missing publish capability on the channel'
          : `unable to publish input; ${errorMessage(error)}`,
        isPermission ? ErrorCode.InsufficientCapability : ErrorCode.SessionSendFailed,
        isPermission ? 401 : 500,
        cause,
      );
    } finally {
      await encoder.close();
    }

    this._logger.debug('ClientTransport.publishInput(); published', { transportMessageId, eventId });
    return { transportMessageId, eventId, runId };
  }

  async cancel(runId: string | Promise<string>): Promise<void> {
    this._logger.trace('ClientTransport.cancel();', {
      runId: typeof runId === 'string' ? runId : '(pending promise)',
    });
    await this._requireOpen('cancel');
    // A promise-valued runId (e.g. a fresh publishInput result's) resolves
    // from the run's ai-run-start; the cancel publishes once it does.
    await this._channel.publish(buildCancelMessage({ runId: await runId }));
  }

  steer(runId: string | Promise<string>, event: TInput): SteerResult {
    this._logger.trace('ClientTransport.steer();', {
      runId: typeof runId === 'string' ? runId : '(pending promise)',
    });
    // .then(): steer() returns its promise pair synchronously, so the open
    // guard merges into the runId promise the coordinator awaits instead of
    // being awaited here. A promise-valued runId (e.g. a publishInput
    // result's) flattens through the .then, so the coordinator always awaits
    // one Promise<string>.
    const runIdWhenOpen = this._requireOpen('steer').then((): string | Promise<string> => runId);
    return this._steer.steer(runIdWhenOpen, event);
  }

  async history(opts?: TransportHistoryOptions): Promise<TransportHistoryResult<TInput, TOutput>> {
    this._logger.trace('ClientTransport.history();');
    await this._requireOpen('history');
    return this._historyPager.next(opts);
  }

  close(): void {
    if (this._closed) return;
    this._logger.info('ClientTransport.close();');
    this._closed = true;
    this._channel.unsubscribe(this._onMessage);
    this._channel.off(this._onChannelStateChange);
    this._steer.drainClosed();
    this._drainRunIdWatches(this._closedError('await run start'));
  }

  /**
   * Drain in-flight steers on a continuity-breaking channel state change:
   * post-loss the channel will not deliver the steer echoes or lifecycle
   * events that would resolve their promises, so they would otherwise hang
   * until `close()`. State changes before the first attach are ignored —
   * there is no continuity to lose yet.
   * @param stateChange - The channel state change to classify.
   */
  private _handleChannelStateChange(stateChange: Ably.ChannelStateChange): void {
    if (this._closed) return;
    if (!this._hasAttachedOnce) {
      if (stateChange.current === 'attached') this._hasAttachedOnce = true;
      return;
    }
    if (!isContinuityLost(stateChange)) return;
    this._logger.warn('ClientTransport._handleChannelStateChange(); channel continuity lost, draining steers', {
      current: stateChange.current,
      resumed: stateChange.resumed,
    });
    this._steer.drainContinuityLost(continuityLostError(stateChange, 'await steer outcome'));
    this._drainRunIdWatches(continuityLostError(stateChange, 'await run start'));
    // Surface the loss on the error stream too: a consumer merging events (or
    // holding a run's chunk stream open) can silently miss messages after the
    // loss, so it needs the signal — the drained promises above only reach
    // callers that were awaiting them.
    this._receiver.emitError(continuityLostError(stateChange, 'deliver events'));
  }

  /**
   * Register a {@link PublishInputResult.runId} watch for a publish under
   * `transportMessageId`. The returned promise carries a pre-attached no-op
   * rejection handler, so a caller that never observes it cannot leak an
   * unhandled rejection when the watch is drained.
   * @param transportMessageId - The publish's transport-message-id to match against
   *   incoming run-starts' `input-transport-message-id`.
   * @returns The runId promise and an `unwatch` to deregister it (used when
   *   the publish itself fails).
   */
  private _watchRunId(transportMessageId: string): { runId: Promise<string>; unwatch: () => void } {
    const { promise: runId, resolve, reject } = Promise.withResolvers<string>();
    runId.catch(() => {
      /* the caller may ignore runId entirely */
    });
    const entry = { resolve, reject };
    const entries = this._runIdWatches.get(transportMessageId) ?? [];
    entries.push(entry);
    this._runIdWatches.set(transportMessageId, entries);
    return {
      runId,
      unwatch: () => {
        const current = this._runIdWatches.get(transportMessageId);
        if (!current) return;
        const idx = current.indexOf(entry);
        if (idx !== -1) current.splice(idx, 1);
        if (current.length === 0) this._runIdWatches.delete(transportMessageId);
      },
    };
  }

  /**
   * Resolve pending runId watches from a classified live event: the first
   * `ai-run-start` whose `input-transport-message-id` matches a watched publish's
   * transport-message-id resolves every watch under that key with the run's id.
   * @param event - The classified transport event to inspect.
   */
  private _resolveRunIdWatches(event: TransportEvent<TInput, TOutput>): void {
    if (event.kind !== 'run-lifecycle' || event.event.type !== 'start') return;
    const key = event.event.inputTransportMessageId;
    if (key === undefined) return;
    const entries = this._runIdWatches.get(key);
    if (!entries) return;
    this._runIdWatches.delete(key);
    const startedRunId = event.event.runId;
    this._logger.debug('ClientTransport._resolveRunIdWatches(); run started for published input', {
      runId: startedRunId,
      inputTransportMessageId: key,
    });
    for (const { resolve } of entries) resolve(startedRunId);
  }

  /**
   * Reject every pending runId watch — on `close()` and on channel continuity
   * loss, after which the run-start that would resolve them can no longer be
   * observed.
   * @param err - The error each watch rejects with.
   */
  private _drainRunIdWatches(err: Ably.ErrorInfo): void {
    if (this._runIdWatches.size === 0) return;
    const drained = [...this._runIdWatches.values()].flat();
    this._runIdWatches.clear();
    for (const { reject } of drained) reject(err);
  }

  /**
   * Guard a write/read verb: reject once closed, and require a successful
   * `connect()` (the shared guard supplies the retry guidance on a failed one).
   * @param method - The method name being guarded, for the error message.
   */
  private async _requireOpen(method: string): Promise<void> {
    if (this._closed) throw this._closedError(method);
    await this._connectGuard.requireConnected(method);
  }

  /**
   * Build the terminal-state error every post-`close()` call rejects with.
   * @param method - The method name being guarded, for the error message.
   * @returns The error.
   */
  private _closedError(method: string): Ably.ErrorInfo {
    return new Ably.ErrorInfo(`unable to ${method}; transport is closed`, ErrorCode.SessionClosed, 400);
  }
}

/**
 * Create a self-contained {@link ClientTransport} over a channel and codec.
 * Construction is synchronous and passive; {@link ClientTransport.connect}
 * subscribes the transport's listener and attaches the channel, after which
 * live events flow to `subscribe` handlers and the publish/history surface
 * opens.
 * @param options - See {@link ClientTransportOptions}.
 * @returns The client transport.
 */
export const createClientTransport = <TInput, TOutput>(
  options: ClientTransportOptions<TInput, TOutput>,
): ClientTransport<TInput, TOutput> => new DefaultClientTransport(options);
