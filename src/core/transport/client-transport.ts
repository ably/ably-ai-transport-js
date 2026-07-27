/**
 * The self-contained client transport: publish, receive, and history over one
 * channel and codec, without the Tree, View, or React layers.
 *
 * {@link createClientTransport} owns its whole receive path: it mints a codec
 * decoder, wraps it in a receive transport, and — once {@link
 * ClientTransport.connect} subscribes and attaches — folds every inbound wire
 * message through it (`deliverEvent`, then `deliverAblyMessage`), so a
 * consumer subscribes to the transport directly instead of wiring a receiver
 * and channel listener by hand.
 *
 * On the send side, `publishInput` stamps the transport-tier headers a `user`
 * input carries (`buildTransportHeaders`), publishes the event through the
 * codec's encoder, and emits an optimistic local `message` echo so the sender
 * sees its own input before the wire round-trips. `cancel` publishes a
 * stateless `ai-cancel` envelope for a run the caller names.
 *
 * `history` pages the channel backwards from the attach point and returns each
 * older slice as a batch of classified events — decoded on the same decoder as
 * the live stream, so a stream spanning the attach boundary is never
 * double-decoded.
 *
 * The transport holds no run registry and no cross-message reconciliation
 * state: a consumer keying on `codecMessageId` reconciles the local echo
 * against the later wire echo, and sources a cancel's `runId` from the receive
 * stream's run-lifecycle events.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { CodecInputEvent, CodecOutputEvent, Decoder, WireCodec } from '../codec/types.js';
import { buildCancelMessage } from './cancel-envelope.js';
import { buildTransportHeaders } from './headers.js';
import { walkHistoryBatch } from './history-walk.js';
import { type HistoryPagesCursor, loadHistoryPages } from './load-history-pages.js';
import { createReceiveTransport, type ReceiveTransport } from './receive-transport.js';
import { ConnectGuard, subscribeAndAttach } from './session-support.js';
import type {
  ClientTransport,
  PublishInputOptions,
  PublishInputResult,
  TransportEvent,
  TransportHistoryOptions,
  TransportHistoryResult,
} from './types/transport.js';
import { wireMetaFromLocalEcho } from './wire-meta.js';

/**
 * Default wire-message limit per Ably history page, used when
 * {@link ClientTransportOptions.historyPageSize} is unset. Over-provisions for
 * the many-Ably-messages-per-domain-message ratio so a single round trip
 * usually covers several domain messages.
 */
const DEFAULT_HISTORY_PAGE_SIZE = 100;

/**
 * Options for {@link createClientTransport}.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface ClientTransportOptions<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent> {
  /** The Ably channel to publish on and receive from. The transport subscribes its own listener on `connect()`; the channel itself stays caller-owned (never detached). */
  channel: Ably.RealtimeChannel;
  /** The wire tier of the codec: its encoder serializes inputs to the wire and its decoder classifies inbound messages. Any full `Codec` satisfies it. */
  codec: WireCodec<TInput, TOutput>;
  /** The publishing client's Ably `clientId`, stamped as `run-client-id` on inputs. When omitted (anonymous), the header is not stamped and the local echo's `clientId` is `undefined`. */
  clientId?: string;
  /** Wire-message limit per `channel.history()` round trip in {@link ClientTransport.history}. Defaults to 100. */
  historyPageSize?: number;
  /** Optional logger for diagnostics. */
  logger?: Logger;
}

/**
 * An input references an existing message (`regenerate`, or any non-user input
 * pinning its own `codecMessageId`) rather than introducing new local content,
 * so it gets no optimistic echo — the referenced content either does not
 * materialise on this side or already exists to be amended when the wire echoes.
 * @param input - The input to classify.
 * @returns True when the input is wire-only.
 */
const isWireOnlyInput = (input: CodecInputEvent): boolean =>
  input.kind !== 'user-message' && (input.kind === 'regenerate' || input.codecMessageId !== undefined);

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
class DefaultClientTransport<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
> implements ClientTransport<TInput, TOutput> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: WireCodec<TInput, TOutput>;
  private readonly _clientId: string | undefined;
  private readonly _historyPageSize: number;
  private readonly _logger: Logger;
  /** The one decoder shared by the live fold and the history scan, so a stream spanning the attach boundary is never double-decoded. */
  private readonly _decoder: Decoder<TInput, TOutput>;
  private readonly _receiver: ReceiveTransport<TInput, TOutput>;
  private readonly _connectGuard = new ConnectGuard();
  /** The channel listener — one bound reference so `close()` can unsubscribe it. */
  private readonly _onMessage: (message: Ably.InboundMessage) => void;
  private _closed = false;
  /**
   * The shared backward history cursor, opened lazily on the first `history()`
   * call (capturing the attach serial then) and advanced by one caller at a
   * time under {@link _historyTail}.
   */
  private _historyCursor: HistoryPagesCursor | undefined;
  /**
   * Tail of the single-flight history chain. Each `history()` links behind the
   * current tail so the cursor is never paged concurrently. A link's failure
   * is its own to throw — the tail stores a settled void promise, so a
   * follower is isolated from a prior link's rejection.
   */
  private _historyTail: Promise<void> = Promise.resolve();

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
    this._onMessage = (message: Ably.InboundMessage) => {
      if (this._closed) return;
      // A failed decode drops the message (the receiver emitted `error`); its
      // raw `ably-message` is not emitted either, so subscribers never see a
      // wire whose typed event never fired.
      if (this._receiver.deliverEvent(message).outcome === 'failed') return;
      this._receiver.deliverAblyMessage(message);
    };
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

  on(event: 'event', handler: (e: TransportEvent<TInput, TOutput>) => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'error', handler: (err: Ably.ErrorInfo) => void): () => void;
  on(
    event: 'event' | 'ably-message' | 'error',
    handler:
      | ((e: TransportEvent<TInput, TOutput>) => void)
      | ((msg: Ably.InboundMessage) => void)
      | ((err: Ably.ErrorInfo) => void),
  ): () => void {
    switch (event) {
      case 'event': {
        // CAST: the public overloads pair each event name with its handler
        // type; TypeScript cannot correlate the union members in the
        // implementation signature.
        return this._receiver.on(event, handler as (e: TransportEvent<TInput, TOutput>) => void);
      }
      case 'ably-message': {
        // CAST: see the 'event' case.
        return this._receiver.on(event, handler as (msg: Ably.InboundMessage) => void);
      }
      case 'error': {
        // CAST: see the 'event' case.
        return this._receiver.on(event, handler as (err: Ably.ErrorInfo) => void);
      }
    }
  }

  async publishInput(event: TInput, opts?: PublishInputOptions): Promise<PublishInputResult> {
    this._logger.trace('ClientTransport.publishInput();');
    await this._requireOpen('publishInput');

    // codec-message-id precedence: explicit option, then an input that pins its
    // own id (a tool resolution amending an assistant), then a fresh id.
    const codecMessageId = opts?.codecMessageId ?? event.codecMessageId ?? crypto.randomUUID();
    const eventId = crypto.randomUUID();

    // Structure fields: the input's own `parent` overrides the option; a
    // `regenerate` maps its `target` to the `msg-regenerate` header.
    const parent = event.parent ?? opts?.parent;
    const forkOf = opts?.forkOf;
    const regenerates = event.kind === 'regenerate' ? event.target : opts?.regenerates;

    const headers = buildTransportHeaders({
      role: 'user',
      runId: opts?.runId,
      codecMessageId,
      runClientId: this._clientId,
      ...(parent !== undefined && { parent }),
      ...(forkOf !== undefined && { forkOf }),
      ...(regenerates !== undefined && { regenerates }),
      inputEventId: eventId,
    });

    const userHeaders = opts?.headers;

    // Optimistic echo for fresh local content only; emitted before the publish
    // so the sender sees its own input without the round-trip. It carries the
    // same user headers the publish will stamp, so the echo and the wire echo
    // surface identical metadata.
    if (!isWireOnlyInput(event)) {
      this._receiver.emitEvent({
        kind: 'message',
        meta: wireMetaFromLocalEcho(headers, this._clientId, userHeaders ?? {}),
        inputs: [event],
        outputs: [],
      });
    }

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
    try {
      await encoder.publishInput(event, { extras: { headers }, messageId: codecMessageId });
    } catch (error) {
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

    this._logger.debug('ClientTransport.publishInput(); published', { codecMessageId, eventId });
    return { codecMessageId, eventId };
  }

  async cancel(runId: string): Promise<void> {
    this._logger.trace('ClientTransport.cancel();', { runId });
    await this._requireOpen('cancel');
    await this._channel.publish(buildCancelMessage({ runId }));
  }

  async history(opts?: TransportHistoryOptions): Promise<TransportHistoryResult<TInput, TOutput>> {
    this._logger.trace('ClientTransport.history();');
    await this._requireOpen('history');

    // Link behind the tail so the shared cursor is advanced by one caller at a
    // time; a prior link's failure is its own to throw.
    const prev = this._historyTail;
    const mine = (async (): Promise<TransportHistoryResult<TInput, TOutput>> => {
      await prev;
      return this._walkHistory(opts);
    })();
    this._historyTail = (async (): Promise<void> => {
      try {
        await mine;
      } catch {
        /* a link's failure is its own caller's to observe */
      }
    })();
    return mine;
  }

  close(): void {
    if (this._closed) return;
    this._logger.info('ClientTransport.close();');
    this._closed = true;
    this._channel.unsubscribe(this._onMessage);
  }

  /**
   * Fetch and classify the next older slice of channel history via the shared
   * {@link walkHistoryBatch}, on the lazily opened cursor and the live
   * stream's decoder. A decode failure is surfaced on the receive stream's
   * `error`, matching the live fold.
   * @param opts - The caller's batch bounds.
   * @returns The batch of classified events and the exhaustion flag.
   */
  private async _walkHistory(
    opts: TransportHistoryOptions | undefined,
  ): Promise<TransportHistoryResult<TInput, TOutput>> {
    if (this._historyCursor === undefined) {
      this._historyCursor = await loadHistoryPages(this._channel, {
        pageLimit: this._historyPageSize,
        untilAttach: true,
        logger: this._logger,
      });
    }
    return walkHistoryBatch(
      {
        cursor: this._historyCursor,
        decoder: this._decoder,
        logger: this._logger,
        onDecodeError: (err) => {
          this._receiver.emitError(err);
        },
      },
      opts,
    );
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
export const createClientTransport = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent>(
  options: ClientTransportOptions<TInput, TOutput>,
): ClientTransport<TInput, TOutput> => new DefaultClientTransport(options);
