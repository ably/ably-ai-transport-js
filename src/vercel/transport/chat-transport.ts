/**
 * A `ChatTransport` for `useChat`, built directly on the standalone
 * {@link ClientTransport}. It holds no conversation state and folds nothing:
 * the UI is driven exclusively through useChat, and this adapter turns the
 * channel's decoded event stream into the `ReadableStream<UIMessageChunk>`
 * useChat consumes, and turns useChat's sends into channel publishes plus an
 * HTTP POST that wakes the agent route.
 *
 * The adapter's whole job is to decide which stream a chunk belongs on. It
 * forwards chunks unchanged and in wire order, and it reads no chunk content:
 * every decision below is made on transport metadata alone.
 *
 * Send paths, chosen from what useChat passes:
 *
 * - **Regenerate** (`trigger: 'regenerate-message'`): publish the regenerate
 *   input naming the message to regenerate from.
 * - **Continuation** (`options.messageId` names an assistant holding tool parts
 *   the user just resolved): publish one action per resolved part, each
 *   addressed by that assistant's `UIMessage.id`.
 * - **Fresh send** (anything else): publish the new user message.
 *
 * Every path publishes to the channel first and POSTs second, because the
 * agent route locates the input in channel history and it has to be there when
 * the route looks. Every path opens a new run: the client never continues one,
 * so no send needs a run id it would have to have stored.
 *
 * The run id comes off the channel, never out of the POST response. The POST
 * only wakes the agent.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
// Named import for the one SDK type used in an `extends` heritage clause: the
// `import-x/namespace` rule can't verify a namespaced generic there. Everywhere
// else the `AI.*` namespace is used.
import type { ChatTransport as SdkChatTransport } from 'ai';
import { readUIMessageStream } from 'ai';

import type { ClientTransport, PublishInputResult, TransportEvent } from '../../core/transport/types.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { VercelInput, VercelOutput } from '../codec/events.js';
import { isToolPart } from '../tool-part.js';

/**
 * Cap on runs whose events the adapter retains for a later replay. A run that
 * ends releases its retention; this bounds the one case that never ends, an
 * agent that died without publishing `ai-run-end`.
 */
const RETAINED_RUN_LIMIT = 8;

/** One classified event off the client transport, at the adapter's instantiation. */
type AdapterEvent<TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools> = TransportEvent<
  VercelInput<TMetadata, TDataParts, TTools>,
  VercelOutput<TMetadata, TDataParts>
>;

/**
 * What {@link ChatTransport.readSince} walked off the channel.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing tool parts.
 */
export interface ReadSinceResult<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> {
  /**
   * The walked messages, oldest first, ready to append to the stored ones.
   * Excludes any message whose run has not ended — those belong to
   * {@link ChatTransport.reconnectToStream}, so that each message has exactly
   * one producer.
   */
  messages: AI.UIMessage<TMetadata, TDataParts, TTools>[];
  /** True when the walk reached the channel start, so there is no older history to page. */
  exhausted: boolean;
}

/**
 * Options for {@link createChatTransport}.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing tool parts.
 */
export interface ChatTransportOptions<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> {
  /**
   * A connected client transport on the conversation's channel. The adapter
   * subscribes to it on construction; the caller owns its lifecycle
   * ({@link ChatTransport.close} stops the adapter's delivery only).
   */
  transport: ClientTransport<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>>;
  /** The conversation's channel name, sent to the chat route so the agent can locate the input. */
  channelName: string;
  /** The chat route URL the invocation pointer is POSTed to. Defaults to `/api/chat`. */
  api?: string;
  /** Logger for the adapter's own diagnostics. Defaults to silent. */
  logger?: Logger;
}

/**
 * The hint an application may pass through `resumeStream({ body })`. The
 * `resume: true` mount path passes no body, so a hint only ever reaches the
 * adapter from a manual call.
 */
export interface ReconnectHint {
  /** Resume this run directly, skipping discovery. */
  runId?: string;
}

/**
 * The `useChat` transport surface this adapter implements: the AI SDK's own
 * `ChatTransport` (so it drops straight into `useChat({ transport })`), plus
 * the hydration walk, a cancel the SDK interface leaves out, and the
 * observation points a shared channel needs.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing tool parts.
 */
export interface ChatTransport<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> extends SdkChatTransport<AI.UIMessage<TMetadata, TDataParts, TTools>> {
  /**
   * Walk the channel backwards from the attach point down to `latestSerial`
   * and return the messages found there, for the application to append to its
   * stored ones with `setMessages`.
   *
   * Subscribes before it pages, so nothing published during the walk is lost.
   * Withholds any message whose run has not ended and retains its events for
   * {@link reconnectToStream}, so exactly one producer builds each message and
   * useChat's reducer never accumulates the same text twice.
   *
   * Call it before {@link reconnectToStream}; reconnecting before the walk has
   * run returns `null`.
   * @param latestSerial - The channel serial of the newest message the application's store holds. Every message at or before it must be complete in the store. Omit to walk to the channel start.
   * @returns The walked messages and whether the walk reached the channel start.
   */
  readSince(latestSerial?: string): Promise<ReadSinceResult<TMetadata, TDataParts, TTools>>;
  /**
   * Cancel the run this adapter currently has a stream open on. A no-op when
   * idle. The AI SDK gives `reconnectToStream` no abort signal, so
   * `useChat.stop()` alone cannot reach the agent for a resumed run; wire this
   * alongside it.
   * @returns Resolves once the cancel has been published.
   */
  cancel(): Promise<void>;
  /**
   * Stop the adapter's event delivery and close every open run stream, so a
   * reader useChat still holds terminates. The underlying client transport is
   * caller-owned and is not closed.
   */
  close(): void;
  /** Whether a run's output stream is currently open (a send or reconnect is in flight). */
  readonly streaming: boolean;
  /**
   * Subscribe to streaming-state transitions. The callback fires with the new
   * value when the adapter moves between streaming and idle.
   * @param callback - Called with the new streaming state to observe it.
   * @returns An unsubscribe function.
   */
  onStreamingChange(callback: (streaming: boolean) => void): () => void;
  /**
   * Subscribe to runs this client did not start. useChat accepts new streamed
   * content only through `resumeStream()`, so an application on a shared
   * channel calls that in response to observe another participant's run.
   * Fires only while this adapter is idle, so it cannot fight the client's own
   * send.
   * @param callback - Called with the foreign run's id to observe it.
   * @returns An unsubscribe function.
   */
  onForeignRun(callback: (runId: string) => void): () => void;
}

/** Internal event map backing the adapter's streaming state. */
interface StreamingEvents {
  /** Fired on every streaming-state transition with the new value. */
  streaming: boolean;
}

/** A run-scoped chunk stream the adapter has handed to useChat. */
interface RunCollector<TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools> {
  /** The stream handed to useChat. */
  stream: ReadableStream<AI.UIMessageChunk>;
  /**
   * Name the run this stream carries, then flush anything buffered while it
   * was unknown.
   * @param runId - The run id, or a promise resolving to it.
   * @param replay - Events to deliver ahead of the buffer, oldest first.
   * @returns Resolves once the run id is known and the replay and buffer have been enqueued. Never rejects: a run id that never arrives errors the stream instead.
   */
  awaitRunId: (
    runId: string | Promise<string>,
    replay?: AdapterEvent<TMetadata, TDataParts, TTools>[],
  ) => Promise<void>;
  /** Tear the stream down without delivering anything further. */
  dispose: () => void;
}

/**
 * The supersede filter's key: a step id is caller-supplied, so two runs can
 * share one, and keying on the step alone would let an older run's output
 * supersede a newer run's.
 * @param runId - The run the event belongs to, when it names one.
 * @param stepId - The step attempt's id.
 * @returns A key unique to the run-and-step pair.
 */
const attemptKey = (runId: string | undefined, stepId: string): string => `${runId ?? ''}\u0000${stepId}`;

/**
 * Drop every output published under a superseded step attempt.
 *
 * Two passes, and it only works with the whole run in hand: pass one finds the
 * highest `step-start-serial` per `step-id`, and pass two drops every message
 * whose own start serial lost. Nothing can be decided until every attempt has
 * been seen, which is why this runs on replay and never live.
 *
 * An event with no step id, or with no start serial (a locally-seeded
 * optimistic event), passes through untouched.
 * @param events - The run's events, oldest first.
 * @returns The events with superseded attempts removed, order preserved.
 */
const dropSupersededAttempts = <TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools>(
  events: AdapterEvent<TMetadata, TDataParts, TTools>[],
): AdapterEvent<TMetadata, TDataParts, TTools>[] => {
  const canonical = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'message') continue;
    const { runId, stepId, stepStartSerial } = event.meta;
    if (stepId === undefined || stepStartSerial === undefined) continue;
    const k = attemptKey(runId, stepId);
    const best = canonical.get(k);
    // Ably serials sort lexicographically, so the highest string is the latest.
    if (best === undefined || stepStartSerial > best) canonical.set(k, stepStartSerial);
  }
  if (canonical.size === 0) return events;
  return events.filter((event) => {
    if (event.kind !== 'message') return true;
    const { runId, stepId, stepStartSerial } = event.meta;
    if (stepId === undefined || stepStartSerial === undefined) return true;
    return canonical.get(attemptKey(runId, stepId)) === stepStartSerial;
  });
};

/**
 * Join two event sequences, dropping any event whose serial has already been
 * seen. A second walk can put one event in both the retention and the live
 * buffer, and delivering it twice would duplicate its content in the reducer.
 * @param events - The events to join, oldest first.
 * @returns The events with serial duplicates removed, order preserved.
 */
const dedupeBySerial = <TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools>(
  events: AdapterEvent<TMetadata, TDataParts, TTools>[],
): AdapterEvent<TMetadata, TDataParts, TTools>[] => {
  const seen = new Set<string>();
  return events.filter((event) => {
    const serial = event.kind === 'message' ? event.meta.serial : event.event.serial;
    // An event with no serial is a local optimistic one; it cannot collide.
    if (serial === undefined) return true;
    if (seen.has(serial)) return false;
    seen.add(serial);
    return true;
  });
};

/**
 * Fold one bucket of chunks through the provider's own reducer.
 *
 * The SDK owns the fold; the only work here is the demultiplexing a provider
 * reducer cannot do for itself, which the caller has already done by bucketing
 * on codec-message-id.
 * @param chunks - The bucket's chunks, in wire order.
 * @returns The last message state the reducer yields, or `undefined` for a bucket that produced none.
 */
const foldBucket = async <TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools>(
  chunks: AI.UIMessageChunk[],
): Promise<AI.UIMessage<TMetadata, TDataParts, TTools> | undefined> => {
  const stream = new ReadableStream<AI.UIMessageChunk>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: AI.UIMessage<TMetadata, TDataParts, TTools> | undefined;
  for await (const message of readUIMessageStream({ stream })) {
    // CAST: the reducer is typed for the SDK's default UIMessage; the chunks
    // fed to it came off this codec's parameterized output type.
    last = message as AI.UIMessage<TMetadata, TDataParts, TTools>;
  }
  return last;
};

class DefaultChatTransport<
  TMetadata,
  TDataParts extends AI.UIDataTypes,
  TTools extends AI.UITools,
> implements ChatTransport<TMetadata, TDataParts, TTools> {
  private readonly _transport: ClientTransport<
    VercelInput<TMetadata, TDataParts, TTools>,
    VercelOutput<TMetadata, TDataParts>
  >;
  private readonly _channelName: string;
  private readonly _api: string;
  private readonly _logger: Logger;

  /** Active run-stream collectors fed from the live event subscription. */
  private readonly _collectors = new Set<(event: AdapterEvent<TMetadata, TDataParts, TTools>) => void>();
  /** Per-open-stream failure hooks: channel continuity loss errors every open stream. */
  private readonly _streamFailers = new Set<(error: Ably.ErrorInfo) => void>();
  /** Per-open-stream close hooks, so `close()` terminates a reader useChat still holds. */
  private readonly _streamClosers = new Set<() => void>();
  /** The run ids this adapter currently has streams open on, newest last. */
  private readonly _openRunIds = new Set<string>();

  /** Live events observed since {@link readSince} subscribed, awaiting a reconnect. */
  private _walkBuffered: AdapterEvent<TMetadata, TDataParts, TTools>[] | undefined;
  /** The buffer collector {@link readSince} installs; `reconnectToStream` takes it over. */
  private _walkCollector: ((event: AdapterEvent<TMetadata, TDataParts, TTools>) => void) | undefined;
  /**
   * Events of messages {@link readSince} withheld, keyed by the run that had
   * not ended. Insertion order is load-bearing in two places: the newest key
   * is the run {@link reconnectToStream} resumes, and the oldest is what the
   * retention cap evicts.
   */
  private readonly _retained = new Map<string, AdapterEvent<TMetadata, TDataParts, TTools>[]>();
  /**
   * Runs seen starting on the live subscription with no end yet, newest last.
   * This is what lets a reconnect go live on a run the walk never saw — the
   * run another participant started after this client hydrated.
   */
  private readonly _liveOpenRuns = new Set<string>();

  private readonly _foreign = new Set<(runId: string) => void>();
  private readonly _emitter: EventEmitter<StreamingEvents>;
  private readonly _unsubscribe: () => void;
  private readonly _unsubscribeError: () => void;
  private _openStreams = 0;
  private _closed = false;

  constructor(options: ChatTransportOptions<TMetadata, TDataParts, TTools>) {
    this._transport = options.transport;
    this._channelName = options.channelName;
    this._api = options.api ?? '/api/chat';
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ChatTransport',
    });
    this._emitter = new EventEmitter<StreamingEvents>(this._logger);

    // Buffer from construction rather than from `readSince`. The decoder hands
    // each wire message out exactly once, and the walk shares it, so an event
    // dropped before the walk installs a collector cannot be recovered from
    // history — the version and duplicate-create guards decode it to nothing.
    this._walkBuffered = [];
    this._walkCollector = (event) => {
      this._walkBuffered?.push(event);
    };
    this._collectors.add(this._walkCollector);
    this._unsubscribe = this._transport.subscribe((event) => {
      this._trackOpenRun(event);
      for (const collector of this._collectors) collector(event);
      this._notifyForeignRun(event);
    });
    // Channel continuity loss means the stream can silently miss its run's
    // terminal, so error every open stream rather than leaving useChat stuck
    // on `streaming`. Other transport errors (a single decode failure, a
    // cancel-publish failure) drop one message and are not stream-fatal.
    this._unsubscribeError = this._transport.on('error', (error) => {
      if (!errorInfoIs(error, ErrorCode.SessionContinuityNotGuaranteed)) return;
      this._logger.error('ChatTransport(); continuity lost, failing open streams');
      for (const fail of this._streamFailers) fail(error);
    });
    this._logger.info('ChatTransport(); adapter created', { channelName: this._channelName, api: this._api });
  }

  get streaming(): boolean {
    return this._openStreams > 0;
  }

  onStreamingChange(callback: (streaming: boolean) => void): () => void {
    this._emitter.on('streaming', callback);
    return () => {
      this._emitter.off('streaming', callback);
    };
  }

  onForeignRun(callback: (runId: string) => void): () => void {
    this._foreign.add(callback);
    return () => {
      this._foreign.delete(callback);
    };
  }

  close(): void {
    this._logger.info('ChatTransport.close(); stopping delivery');
    this._closed = true;
    this._unsubscribe();
    this._unsubscribeError();
    // Terminate the readers useChat still holds before dropping the hooks that
    // could do it: a stream that never ends hangs useChat on `streaming`.
    for (const closeStream of this._streamClosers) closeStream();
    this._collectors.clear();
    this._streamFailers.clear();
    this._streamClosers.clear();
    this._openRunIds.clear();
    this._liveOpenRuns.clear();
    this._retained.clear();
    this._walkCollector = undefined;
    this._walkBuffered = undefined;
    // Every closer ran `finish()` above, which decremented the counter and
    // emitted the transition at zero, so there is nothing left to reset here.
  }

  async cancel(): Promise<void> {
    this._logger.trace('ChatTransport.cancel();');
    const runId = [...this._openRunIds].at(-1);
    if (runId === undefined) return;
    this._logger.debug('ChatTransport.cancel(); cancelling open run', { runId });
    await this._transport.cancel(runId);
  }

  async sendMessages(
    options: Parameters<SdkChatTransport<AI.UIMessage<TMetadata, TDataParts, TTools>>['sendMessages']>[0],
  ): Promise<ReadableStream<AI.UIMessageChunk>> {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to send; the chat transport is closed', ErrorCode.SessionClosed, 400);
    }
    this._logger.trace('ChatTransport.sendMessages();', { trigger: options.trigger });

    if (options.trigger === 'regenerate-message') {
      return this._sendRegenerate(options.messageId, options.abortSignal);
    }

    // The dispatch reads `options.messageId`, which is the only thing useChat
    // tells us about intent. A submit naming an assistant is the user having
    // resolved that message's tool parts; anything else is a new turn.
    const named =
      options.messageId === undefined
        ? undefined
        : options.messages.find((message) => message.id === options.messageId);
    if (named?.role === 'assistant') {
      return this._sendContinuation(named, options.abortSignal);
    }

    const last = options.messages.at(-1);
    if (!last) {
      throw new Ably.ErrorInfo('unable to send; the message list is empty', ErrorCode.InvalidArgument, 400);
    }
    return this._sendFresh(last, options.abortSignal);
  }

  async readSince(latestSerial?: string): Promise<ReadSinceResult<TMetadata, TDataParts, TTools>> {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to walk history; the chat transport is closed', ErrorCode.SessionClosed, 400);
    }
    this._logger.trace('ChatTransport.readSince();', { latestSerial });

    // The buffer has been running since construction, so everything published
    // between attach and here is already held. history() is bounded at the
    // attach point and shares the live decoder, so the buffered events are
    // strictly newer than every page and the seam needs no reconciling.
    // A second walk keeps the buffer: those events still belong to whoever
    // reconnects next. The overlap a re-walk creates is removed by serial at
    // hand-off.
    if (this._walkBuffered === undefined) this._installWalkBuffer();

    let all: AdapterEvent<TMetadata, TDataParts, TTools>[] = [];
    let exhausted = false;
    while (!exhausted) {
      const batch = await this._transport.history();
      all = [...batch.events, ...all];
      exhausted = batch.exhausted;
      if (latestSerial !== undefined && this._reached(all, latestSerial)) break;
    }

    // Everything at or before the store's serial is the store's to report.
    const walked =
      latestSerial === undefined
        ? all
        : all.filter((event) => {
            // Lifecycle events carry their own serial; reading only the
            // message arm would keep a dead run's start and classify it open.
            const serial = event.kind === 'message' ? event.meta.serial : event.event.serial;
            return serial === undefined || serial > latestSerial;
          });

    const openRuns = this._openRunsIn(walked);
    this._retain(walked, openRuns);

    const messages = await this._foldWalked(walked, openRuns);
    this._logger.debug('ChatTransport.readSince(); walk complete', {
      messages: messages.length,
      withheldRuns: openRuns.size,
      exhausted,
    });
    return { messages, exhausted };
  }

  async reconnectToStream(
    options?: Parameters<SdkChatTransport<AI.UIMessage<TMetadata, TDataParts, TTools>>['reconnectToStream']>[0],
  ): Promise<ReadableStream<AI.UIMessageChunk> | null> {
    this._logger.trace('ChatTransport.reconnectToStream();');
    // eslint-disable-next-line unicorn/no-null -- null is required by the AI SDK ChatTransport contract
    if (this._closed) return null;

    // Resolution order: the application's explicit hint, then the newest run
    // the walk withheld a message for, then the newest run seen starting live
    // that this client is not already streaming — that last one is how a
    // participant joins a run another client started (see `onForeignRun`).
    const hinted = readReconnectHint(options)?.runId;
    const runId =
      hinted ??
      [...this._retained.keys()].at(-1) ??
      [...this._liveOpenRuns].findLast((id) => !this._openRunIds.has(id));
    if (runId === undefined) {
      // Nothing to resume, so the walk's hand-off window is over. Releasing the
      // buffer here is what stops it accumulating every event on the channel
      // for the life of the page on the commonest hydration path.
      this._clearWalkBuffer();
      // eslint-disable-next-line unicorn/no-null -- null is required by the AI SDK ChatTransport contract
      return null;
    }

    const retained = this._retained.get(runId) ?? [];
    const buffered = this._walkBuffered ?? [];
    // The collector's own subscription takes over from the walk's buffer, so
    // every live event lands exactly once: in `buffered` (walk-time), or in the
    // collector (from here on).
    const collector = this._openRunStream();
    this._clearWalkBuffer();
    this._retained.delete(runId);

    // Replay the withheld message on a reducer that holds nothing for it, then
    // the events the buffer holds. A re-walk can put one event in both, so the
    // two are joined on serial. The canonical-attempt filter then runs over the
    // whole replay, so a superseded attempt's output never reaches useChat.
    // Awaited so the returned stream already holds its replay: useChat starts
    // reading a stream whose withheld message is buffered, not one that fills
    // in behind it.
    await collector.awaitRunId(runId, dropSupersededAttempts(dedupeBySerial([...retained, ...buffered])));
    return collector.stream;
  }

  // -------------------------------------------------------------------------
  // Private: send paths
  // -------------------------------------------------------------------------

  /**
   * Publish the new user message and wake the agent.
   * @param message - The new user message useChat appended.
   * @param abortSignal - useChat's per-send abort signal.
   * @returns The run's chunk stream.
   */
  private async _sendFresh(
    message: AI.UIMessage<TMetadata, TDataParts, TTools>,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<AI.UIMessageChunk>> {
    return this._send(abortSignal, async () => this._transport.publishInput({ kind: 'message', payload: message }));
  }

  /**
   * Publish one action per resolved tool part on the assistant useChat named,
   * then wake the agent.
   *
   * Each action is addressed by the assistant's own `UIMessage.id` and carries
   * no run id: a resolution opens a new run like any other input, so nothing
   * here depends on a run surviving a page refresh.
   * @param assistant - The assistant message useChat named through `options.messageId`.
   * @param abortSignal - useChat's per-send abort signal.
   * @returns The new run's chunk stream.
   */
  private async _sendContinuation(
    assistant: AI.UIMessage<TMetadata, TDataParts, TTools>,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<AI.UIMessageChunk>> {
    const [first, ...rest] = this._actionsOn(assistant);
    if (first === undefined) {
      throw new Ably.ErrorInfo(
        `unable to continue; message ${assistant.id} has no resolved tool parts`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    // The last publish is the one the POST points at: the agent locates that
    // input and the earlier actions are already on the channel ahead of it.
    return this._send(abortSignal, async () => {
      let sent = await this._transport.publishInput(first, { codecMessageId: assistant.id });
      for (const action of rest) {
        sent = await this._transport.publishInput(action, { codecMessageId: assistant.id });
      }
      return sent;
    });
  }

  /**
   * Publish the regenerate input and wake the agent.
   * @param messageId - The message useChat is regenerating from.
   * @param abortSignal - useChat's per-send abort signal.
   * @returns The new run's chunk stream.
   */
  private async _sendRegenerate(
    messageId: string | undefined,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<AI.UIMessageChunk>> {
    if (messageId === undefined) {
      throw new Ably.ErrorInfo('unable to regenerate; useChat named no message', ErrorCode.InvalidArgument, 400);
    }
    return this._send(abortSignal, async () =>
      this._transport.publishInput({ kind: 'regenerate', payload: { messageId } }),
    );
  }

  /**
   * The shared send shape: open a collector, publish, wake the agent, and hand
   * the collector the run id the channel reports. A failure anywhere disposes
   * the collector so useChat is never left holding a stream that cannot end.
   * @param abortSignal - useChat's per-send abort signal.
   * @param publish - Publishes the path's input and returns the publish result.
   * @returns The run's chunk stream.
   */
  private async _send(
    abortSignal: AbortSignal | undefined,
    publish: () => Promise<Pick<PublishInputResult, 'eventId' | 'runId'>>,
  ): Promise<ReadableStream<AI.UIMessageChunk>> {
    const collector = this._openRunStream(abortSignal);
    try {
      const sent = await publish();
      await this._postChat(sent.eventId);
      // The run id is resolved from the channel, off the first `ai-run-start`
      // whose input-codec-message-id matches this publish. It never comes out
      // of the POST response: the route only wakes the agent.
      //
      // Deliberately not awaited: useChat needs the stream back now, and the
      // id lands on it later. A run that never starts errors the stream rather
      // than rejecting here.
      void collector.awaitRunId(sent.runId);
    } catch (error) {
      this._logger.error('ChatTransport._send(); send failed', { error });
      collector.dispose();
      throw error;
    }
    return collector.stream;
  }

  /**
   * Build the publishable actions on one assistant message: the codec's
   * approval body for a decided approval, the provider's own tool-output chunk
   * for a resolved call.
   * @param assistant - The assistant message useChat named.
   * @returns One input per resolved tool part, in part order.
   */
  private _actionsOn(
    assistant: AI.UIMessage<TMetadata, TDataParts, TTools>,
  ): VercelInput<TMetadata, TDataParts, TTools>[] {
    const actions: VercelInput<TMetadata, TDataParts, TTools>[] = [];
    for (const part of assistant.parts) {
      if (!isToolPart(part)) continue;
      switch (part.state) {
        case 'approval-responded': {
          actions.push({
            kind: 'approval',
            payload: {
              messageId: assistant.id,
              toolCallId: part.toolCallId,
              approved: part.approval.approved,
              ...(part.approval.reason === undefined ? {} : { reason: part.approval.reason }),
            },
          });
          break;
        }
        case 'output-available': {
          actions.push({
            kind: 'chunk',
            payload: {
              type: 'tool-output-available',
              toolCallId: part.toolCallId,
              output: part.output,
              ...(part.type === 'dynamic-tool' ? { dynamic: true } : {}),
            },
          });
          break;
        }
        case 'output-error': {
          actions.push({
            kind: 'chunk',
            payload: {
              type: 'tool-output-error',
              toolCallId: part.toolCallId,
              errorText: part.errorText,
              ...(part.type === 'dynamic-tool' ? { dynamic: true } : {}),
            },
          });
          break;
        }
        // No default
      }
    }
    return actions;
  }

  // -------------------------------------------------------------------------
  // Private: hydration
  // -------------------------------------------------------------------------

  /**
   * Whether the walk has reached back past the store's serial.
   * @param all - Everything scanned so far, oldest first.
   * @param latestSerial - The store's serial.
   * @returns True once the oldest scanned message is at or before the serial.
   */
  private _reached(all: AdapterEvent<TMetadata, TDataParts, TTools>[], latestSerial: string): boolean {
    for (const event of all) {
      if (event.kind !== 'message') continue;
      const { serial } = event.meta;
      if (serial !== undefined) return serial <= latestSerial;
    }
    return false;
  }

  /**
   * The runs in the walk that published no `ai-run-end`. Their messages are
   * the adapter's to deliver, not the store's.
   * @param walked - The walked events, oldest first.
   * @returns The open runs' ids.
   */
  private _openRunsIn(walked: AdapterEvent<TMetadata, TDataParts, TTools>[]): Set<string> {
    const seen = new Set<string>();
    const ended = new Set<string>();
    for (const event of walked) {
      if (event.kind === 'run-lifecycle') {
        seen.add(event.event.runId);
        if (event.event.type === 'end') ended.add(event.event.runId);
        continue;
      }
      if (event.kind === 'message' && event.meta.runId !== undefined) seen.add(event.meta.runId);
    }
    for (const runId of ended) seen.delete(runId);
    return seen;
  }

  /**
   * Retain the withheld runs' events for a later replay, newest run last.
   * @param walked - The walked events, oldest first.
   * @param openRuns - The runs whose messages are withheld.
   */
  private _retain(walked: AdapterEvent<TMetadata, TDataParts, TTools>[], openRuns: Set<string>): void {
    // A run an earlier walk withheld may have ended since. Anything this walk
    // does not report open is no longer the adapter's to deliver.
    for (const runId of this._retained.keys()) {
      if (!openRuns.has(runId)) this._retained.delete(runId);
    }
    for (const runId of openRuns) {
      const events = walked.filter((event) =>
        event.kind === 'message' ? event.meta.runId === runId : event.event.runId === runId,
      );
      // Delete-then-set re-seats the key as newest. Insertion order is what
      // `reconnectToStream` reads to pick the newest withheld run, and what the
      // cap below reads to evict the oldest.
      this._retained.delete(runId);
      this._retained.set(runId, events);
    }
    // A run that never ends never releases its retention, so bound the map.
    while (this._retained.size > RETAINED_RUN_LIMIT) {
      const oldest = this._retained.keys().next();
      if (oldest.done === true) break;
      this._retained.delete(oldest.value);
    }
  }

  /**
   * Fold the walked events into messages, skipping the withheld runs.
   *
   * Client inputs are already whole `UIMessage`s and pass straight through.
   * Agent output is bucketed by codec-message-id — the demultiplexing a
   * provider reducer cannot do for itself — and each bucket folded by the SDK.
   * @param walked - The walked events, oldest first.
   * @param openRuns - The runs whose messages are withheld.
   * @returns The messages, oldest first.
   */
  private async _foldWalked(
    walked: AdapterEvent<TMetadata, TDataParts, TTools>[],
    openRuns: Set<string>,
  ): Promise<AI.UIMessage<TMetadata, TDataParts, TTools>[]> {
    const order: string[] = [];
    const buckets = new Map<string, AI.UIMessageChunk[]>();
    const direct = new Map<string, AI.UIMessage<TMetadata, TDataParts, TTools>>();

    for (const event of dropSupersededAttempts(walked)) {
      if (event.kind !== 'message') continue;
      const { codecMessageId, runId } = event.meta;
      if (codecMessageId === undefined) continue;
      if (runId !== undefined && openRuns.has(runId)) continue;

      for (const input of event.inputs) {
        if (input.kind !== 'message') continue;
        // The `message` batch explodes one UIMessage into one wire message per
        // part, and each decodes back as a one-part input, so the parts have
        // to be concatenated rather than overwritten: a message with a file
        // and some text arrives as two events and must not lose the file.
        const existing = direct.get(input.payload.id);
        if (existing === undefined) {
          order.push(input.payload.id);
          direct.set(input.payload.id, { ...input.payload, parts: [...input.payload.parts] });
          continue;
        }
        existing.parts.push(...input.payload.parts);
      }
      if (event.outputs.length === 0) continue;
      const bucket = buckets.get(codecMessageId);
      if (bucket === undefined) {
        order.push(codecMessageId);
        buckets.set(codecMessageId, [...event.outputs]);
      } else {
        bucket.push(...event.outputs);
      }
    }

    const messages: AI.UIMessage<TMetadata, TDataParts, TTools>[] = [];
    for (const id of order) {
      const own = direct.get(id);
      if (own !== undefined) {
        messages.push(own);
        continue;
      }
      const folded = await foldBucket<TMetadata, TDataParts, TTools>(buckets.get(id) ?? []);
      if (folded !== undefined) messages.push(folded);
    }
    return messages;
  }

  // -------------------------------------------------------------------------
  // Private: streaming
  // -------------------------------------------------------------------------

  /**
   * Start buffering live events for a later hand-off to `reconnectToStream`.
   */
  private _installWalkBuffer(): void {
    const live: AdapterEvent<TMetadata, TDataParts, TTools>[] = [];
    const buffer = (event: AdapterEvent<TMetadata, TDataParts, TTools>): void => {
      live.push(event);
    };
    this._collectors.add(buffer);
    this._walkCollector = buffer;
    this._walkBuffered = live;
  }

  /**
   * Drop the walk's live buffer and its subscription.
   *
   * The buffer and the collector that fills it are one thing in two fields, so
   * every teardown site clears both together.
   */
  private _clearWalkBuffer(): void {
    if (this._walkCollector) this._collectors.delete(this._walkCollector);
    this._walkCollector = undefined;
    this._walkBuffered = undefined;
  }

  /**
   * Track which runs are open on the live subscription.
   *
   * A reconnect with nothing retained resumes the newest of these, which is
   * how a client joins a run another participant started after it hydrated.
   * @param event - The classified transport event.
   */
  private _trackOpenRun(event: AdapterEvent<TMetadata, TDataParts, TTools>): void {
    if (event.kind !== 'run-lifecycle') return;
    const { runId, type } = event.event;
    if (type === 'end') {
      this._liveOpenRuns.delete(runId);
      // A retained run that has since ended must not stay resumable: replaying
      // it would leave a stream waiting for a terminal that already passed.
      this._retained.delete(runId);
      return;
    }
    // Re-seat the id so the set's iteration order stays newest-last.
    this._liveOpenRuns.delete(runId);
    this._liveOpenRuns.add(runId);
  }

  /**
   * Tell the foreign-run subscribers about a run this client did not start.
   *
   * Gated on being idle, so it cannot fight this client's own send, and on the
   * run not already being one of ours.
   * @param event - The classified transport event.
   */
  private _notifyForeignRun(event: AdapterEvent<TMetadata, TDataParts, TTools>): void {
    if (this._foreign.size === 0) return;
    if (event.kind !== 'run-lifecycle' || event.event.type !== 'start') return;
    if (this.streaming) return;
    const { runId } = event.event;
    if (this._openRunIds.has(runId)) return;
    for (const callback of this._foreign) {
      try {
        callback(runId);
      } catch (error) {
        this._logger.error('ChatTransport._notifyForeignRun(); callback threw', { error });
      }
    }
  }

  /**
   * Open a chunk stream for one run.
   *
   * Events are buffered until the run id is known, then filtered by it:
   * a `message` event enqueues its output chunks unchanged and in wire order,
   * the run's `end` closes the stream (or errors it when the run ended in
   * error), and a step attempt starting again after this stream forwarded
   * output for it errors the stream, because the parts already written cannot
   * be un-written in place.
   * @param abortSignal - useChat's per-send abort signal.
   * @returns The collector.
   */
  private _openRunStream(abortSignal?: AbortSignal): RunCollector<TMetadata, TDataParts, TTools> {
    let runId: string | undefined;
    let closed = false;
    // Read through a call so control-flow narrowing does not assume `closed`
    // is still false after `deliver` (which can close via `finish`).
    const isClosed = (): boolean => closed;
    const buffered: AdapterEvent<TMetadata, TDataParts, TTools>[] = [];
    const delivered: AdapterEvent<TMetadata, TDataParts, TTools>[] = [];
    const forwardedSteps = new Set<string>();
    let controller: ReadableStreamDefaultController<AI.UIMessageChunk> | undefined;

    this._openStreams++;
    if (this._openStreams === 1) this._emitter.emit('streaming', true);

    const finish = (): void => {
      if (closed) return;
      closed = true;
      detachAbort();
      this._collectors.delete(handleEvent);
      this._streamFailers.delete(failStream);
      this._streamClosers.delete(closeStream);
      if (runId !== undefined) this._openRunIds.delete(runId);
      this._openStreams--;
      if (this._openStreams === 0) this._emitter.emit('streaming', false);
    };

    const deliver = (event: AdapterEvent<TMetadata, TDataParts, TTools>, id: string): void => {
      if (event.kind === 'message') {
        if (event.meta.runId !== id) return;
        const { stepId } = event.meta;
        if (stepId !== undefined) forwardedSteps.add(stepId);
        // Keep what this stream forwarded. A live supersede errors the stream
        // and the consumer repairs by resuming, and that replay needs the
        // whole run in hand for the two-pass filter to pick the canonical
        // attempt. The run's own end releases it.
        delivered.push(event);
        for (const chunk of event.outputs) controller?.enqueue(chunk);
        return;
      }
      if (event.kind === 'step-lifecycle') {
        if (event.event.runId !== id) return;
        // A step this stream already forwarded output for is starting again, so
        // what useChat holds belongs to a superseded attempt. Parts accumulate
        // and no chunk removes one, so the stream cannot be repaired in place:
        // error it and let the consumer drop the message and resume.
        if (event.event.type !== 'step-start' || !forwardedSteps.has(event.event.stepId)) return;
        this._logger.warn('ChatTransport._openRunStream(); step attempt superseded live', {
          runId: id,
          stepId: event.event.stepId,
        });
        // Hand the run's events to the retention so the consumer's repair —
        // drop the damaged message and resume — has something to replay.
        this._retained.delete(id);
        this._retained.set(id, [...delivered, event]);
        finish();
        controller?.error(
          new Ably.ErrorInfo(
            `unable to continue the stream; step ${event.event.stepId} was superseded by a later attempt`,
            ErrorCode.RunAttemptSuperseded,
            500,
          ),
        );
        return;
      }
      if (event.event.runId !== id) return;
      if (event.event.type === 'suspend') {
        // A run that suspends publishes no end, so this stream can never
        // terminate on its own. Nothing in this adapter suspends a run — every
        // client input opens a fresh one — so reaching here means the agent
        // suspended instead of ending, and useChat is now stuck on
        // `streaming`. Log it rather than inventing a terminal the wire did
        // not carry.
        this._logger.warn('ChatTransport._openRunStream(); run suspended, stream cannot terminate', { runId: id });
        return;
      }
      if (event.event.type !== 'end') return;
      finish();
      // A run that ended in error shows useChat a failure rather than a
      // completion, so a route that died after its pipe cannot look finished.
      if (event.event.reason === 'error') controller?.error(event.event.error);
      else controller?.close();
    };

    const handleEvent = (event: AdapterEvent<TMetadata, TDataParts, TTools>): void => {
      if (closed) return;
      if (runId === undefined) {
        buffered.push(event);
        return;
      }
      deliver(event, runId);
    };
    this._collectors.add(handleEvent);

    const failStream = (error: Ably.ErrorInfo): void => {
      if (closed) return;
      finish();
      controller?.error(error);
    };
    this._streamFailers.add(failStream);

    const closeStream = (): void => {
      if (closed) return;
      finish();
      controller?.close();
    };
    this._streamClosers.add(closeStream);

    // A failed cancel publish is unrecoverable here and the stream still closes
    // on the run's own end event, so it is best-effort — but it is not
    // nothing: a cancel that never reached the wire leaves the agent running
    // while the UI has moved on, and only a log says so.
    const cancelRun = (id: string): void => {
      void this._transport.cancel(id).catch((error: unknown) => {
        this._logger.warn('ChatTransport._openRunStream(); cancel publish failed', { runId: id, error });
      });
    };

    const onAbort = (): void => {
      if (closed || runId === undefined) return;
      cancelRun(runId);
    };
    abortSignal?.addEventListener('abort', onAbort);

    const detachAbort = (): void => {
      abortSignal?.removeEventListener('abort', onAbort);
    };

    return {
      stream: new ReadableStream<AI.UIMessageChunk>({
        start: (streamController) => {
          controller = streamController;
        },
        cancel: () => {
          finish();
        },
      }),
      awaitRunId: async (
        id: string | Promise<string>,
        replay?: AdapterEvent<TMetadata, TDataParts, TTools>[],
      ): Promise<void> => {
        const settle = (resolved: string): void => {
          if (closed) return;
          runId = resolved;
          this._openRunIds.add(resolved);
          // An abort that landed before the id was known still has to reach the
          // agent, so re-check rather than relying on the listener alone.
          if (abortSignal?.aborted) cancelRun(resolved);
          // Replay (older than anything buffered live) first, then the
          // collector's own buffer, keeping delivery chronological throughout.
          for (const event of replay ?? []) {
            if (isClosed()) break;
            deliver(event, resolved);
          }
          for (const event of buffered) {
            if (isClosed()) break;
            deliver(event, resolved);
          }
          buffered.length = 0;
        };
        if (typeof id === 'string') {
          settle(id);
          return;
        }
        // A run that never starts must fail the stream rather than hang it.
        // Resolving either way keeps this promise a flush barrier, not an
        // error channel: the failure reaches the consumer on the stream.
        await id.then(settle, (error: unknown) => {
          if (closed) return;
          this._logger.error('ChatTransport._openRunStream(); run never started, failing stream', { error });
          finish();
          // Not a send failure: the publish and the POST both succeeded and
          // the run never started, which is the run's response stream failing
          // before it produced anything.
          controller?.error(
            error instanceof Ably.ErrorInfo
              ? error
              : new Ably.ErrorInfo(
                  `unable to stream the run; ${errorMessage(error)}`,
                  ErrorCode.RunResponseStreamFailed,
                  500,
                  errorCause(error),
                ),
          );
        });
      },
      dispose: (): void => {
        finish();
      },
    };
  }

  /**
   * POST the invocation pointer to the chat route, waking the agent.
   *
   * The response body is not read. The run id travels over the channel in both
   * directions, so the only thing this call reports is whether the route was
   * reachable.
   * @param eventId - The published input's event id, which the agent locates.
   * @throws {@link Ably.ErrorInfo} with {@link ErrorCode.SessionSendFailed} when the route is unreachable or answers non-2xx.
   */
  private async _postChat(eventId: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this._api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelName: this._channelName, eventId }),
      });
    } catch (error) {
      throw new Ably.ErrorInfo(
        `unable to send; the POST to ${this._api} failed: ${errorMessage(error)}`,
        ErrorCode.SessionSendFailed,
        500,
        errorCause(error),
      );
    }
    if (!response.ok) {
      throw new Ably.ErrorInfo(
        `unable to send; the POST to ${this._api} returned ${String(response.status)}`,
        ErrorCode.SessionSendFailed,
        response.status,
      );
    }
  }
}

/**
 * Read the adapter's hint off `reconnectToStream`'s body.
 * @param options - Whatever the AI SDK passed, if anything.
 * @returns The hint, or `undefined` when the caller supplied none.
 */
const readReconnectHint = (options: { body?: unknown } | undefined): ReconnectHint | undefined => {
  const body = options?.body;
  if (typeof body !== 'object' || body === null) return undefined;
  if (!('runId' in body)) return undefined;
  const { runId } = body;
  return typeof runId === 'string' ? { runId } : undefined;
};

/**
 * Create a {@link ChatTransport} over a connected {@link ClientTransport} —
 * the object `useChat({ transport })` consumes directly, with no companion
 * hook and no external message state.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 * @param options - The adapter's transport, channel name, and route; see {@link ChatTransportOptions}.
 * @returns The chat transport.
 */
export const createChatTransport = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  options: ChatTransportOptions<TMetadata, TDataParts, TTools>,
): ChatTransport<TMetadata, TDataParts, TTools> => new DefaultChatTransport(options);
