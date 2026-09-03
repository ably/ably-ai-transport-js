/**
 * A `ChatTransport` for `useChat`, built directly on the standalone
 * {@link ClientTransport}. useChat owns the message store; the adapter keeps
 * no store of its own.
 *
 * It has two jobs.
 *
 * On the **streaming path** it turns the channel's decoded event stream into
 * the `ReadableStream<UIMessageChunk>`s useChat consumes, and turns useChat's
 * sends into channel publishes plus an HTTP POST that wakes the agent route.
 * Here it only decides which stream a chunk belongs on: chunks are forwarded
 * unchanged and in wire order, routed on transport metadata alone.
 *
 * On the **hydration path** {@link ChatTransport.readSince} walks channel
 * history and groups the events it finds by the message each belongs to,
 * handing every event back as it was published. Turning a group into a
 * `UIMessage` is the application's job, through the provider's own reducer.
 * The walk also holds the events of any run that has not ended so
 * {@link ChatTransport.reconnectToStream} can replay them. That retention is
 * the one piece of conversation state the adapter carries, and it is bounded.
 *
 * Send paths, chosen from what useChat passes:
 *
 * - **Regenerate** (`trigger: 'regenerate-message'`): publish the regenerate
 *   input naming the message to regenerate from.
 * - **Continuation** (`options.messageId` names an assistant holding tool parts
 *   the user just resolved): publish one action per resolved part, each naming
 *   that assistant's `UIMessage.id` in its body.
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

import type { ClientTransport, PublishInputResult, TransportEvent } from '../../core/transport/types.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { errorMessage } from '../../utils.js';
import type { VercelInput, VercelOutput } from '../codec/events.js';
import { isToolPart } from '../tool-part.js';

/**
 * Cap on runs whose events the adapter retains for a later replay. A run that
 * ends releases its retention; this bounds the one case that never ends, an
 * agent that died without publishing `ai-run-end`.
 */
const RETAINED_RUN_LIMIT = 8;

/**
 * Cap on the live events held for a later replay. The buffer runs from
 * construction so nothing published before the hydration walk is lost, and an
 * application that never hydrates would otherwise accumulate every event on
 * the channel for the life of the page.
 */
const LIVE_BUFFER_LIMIT = 2000;

/**
 * Cap on the transport-message-ids the adapter remembers as its own, so
 * {@link ChatTransport.onForeignInput} can suppress the echo of this client's
 * own publish. An echo arrives within milliseconds of the publish that caused
 * it, so a short window is enough and the set cannot grow with the
 * conversation.
 */
const OWN_INPUT_ID_LIMIT = 64;

/**
 * How long a send waits for the channel to name its run before giving up.
 * Nothing else bounds that wait: a route that answers 200 and then dies, or an
 * agent that opens its run without threading the triggering input, would
 * otherwise leave the stream open and useChat streaming for ever.
 */
const RUN_ID_TIMEOUT_MS = 30_000;

/** One classified event off the client transport, at the adapter's instantiation. */
type AdapterEvent<TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools> = TransportEvent<
  VercelInput<TMetadata, TDataParts, TTools>,
  VercelOutput<TMetadata, TDataParts>
>;

/**
 * One walked event, tagged with the direction it travelled.
 *
 * The tag is on the wrapper because the payload cannot be probed for it: a
 * codec input carries a `kind` field, and so does v7's `custom` output chunk.
 * The wire separates the two by message name, and this preserves that.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing tool parts.
 */
export type WalkedEvent<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> =
  | {
      /** Discriminator for a body a client published. */
      direction: 'input';
      /** The decoded input, exactly as it was published. */
      event: VercelInput<TMetadata, TDataParts, TTools>;
    }
  | {
      /** Discriminator for a chunk the agent published. */
      direction: 'output';
      /** The decoded chunk, exactly as it was published. */
      event: VercelOutput<TMetadata, TDataParts>;
    };

/**
 * The events of one message, in wire order.
 *
 * Assembling them into an `AI.UIMessage` is the application's job. Feed a
 * group's output chunks to the provider's own reducer, one call per group,
 * because `readUIMessageStream` holds the state of a single message and a
 * second `start` in the same call inherits the first message's parts.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing tool parts.
 */
export interface WalkedMessage<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> {
  /**
   * The message's domain `UIMessage.id`, or the wire id of the events when
   * nothing in the group named one (a stream joined mid-flight).
   */
  id: string;
  /**
   * The group's events, each exactly as it was published.
   *
   * Wire order within each publish, and publish order between them. A message
   * assembled from more than one publish therefore reads as the first
   * publish's events then the second's, which is chronological because a
   * publish's events are contiguous on the channel.
   */
  events: WalkedEvent<TMetadata, TDataParts, TTools>[];
}

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
   * The walked events, grouped by the message they belong to, oldest first.
   * Excludes any message whose run has not ended — those belong to
   * {@link ChatTransport.reconnectToStream}, so that each message has exactly
   * one producer.
   */
  messages: WalkedMessage<TMetadata, TDataParts, TTools>[];
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
 * The hint an application may pass through `resumeStream({ body })` to resume
 * one specific run, skipping {@link ChatTransport.reconnectToStream}'s own
 * discovery.
 *
 * The `resume: true` mount path passes no body, so a hint only ever reaches
 * the adapter from a manual `resumeStream()` call — typically the one an
 * application makes in response to {@link ChatTransport.onForeignRun}, where
 * it already knows the run id and has no reason to let the adapter guess.
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
 *
 * `sendMessages` and `reconnectToStream` are inherited unchanged, so their
 * signatures carry the SDK's own docs. Two things about this adapter's
 * behaviour are not visible from them: `reconnectToStream` resolves which run
 * to resume in the order given on {@link readSince}, and a caller can skip
 * that discovery by passing {@link ReconnectHint} through
 * `resumeStream({ body })`.
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
   * and return the events found there, grouped by the message each belongs to.
   *
   * Every event comes back as it was published. The application assembles a
   * group into an `AI.UIMessage` with the provider's own reducer and appends
   * the result to its stored messages with `setMessages`; see
   * {@link WalkedMessage} for why the reducer takes one call per group.
   *
   * Subscribes before it pages, so nothing published during the walk is lost.
   * Withholds any message whose run has not ended and retains its events for
   * {@link reconnectToStream}, so exactly one producer builds each message and
   * useChat's reducer never accumulates the same text twice.
   *
   * Call it before {@link reconnectToStream} on the hydration path. With no
   * hint and no run seen open since construction, reconnecting before the walk
   * has run returns `null`.
   * @param latestSerial - The channel serial of the newest message the application's store holds. Every message at or before it must be complete in the store. Omit to walk to the channel start.
   * @returns The walked groups and whether the walk reached the channel start.
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
  /**
   * Subscribe to inputs another participant published on the shared channel.
   *
   * `reconnectToStream` carries a run's output alone, and the reducer behind
   * it builds one assistant message, so a client that only observes another
   * participant's run renders the reply with nothing that prompted it. This is
   * how the prompt reaches it. The callback fires for every input decoded off
   * the channel except this adapter's own publishes, and fires before the run
   * those inputs trigger starts.
   *
   * Unlike {@link onForeignRun} it is not gated on being idle: an input this
   * adapter declines is lost until the next hydration, where a run it declines
   * to resume ends on its own.
   *
   * An application appends a `kind: 'message'` payload to useChat's list with
   * `setMessages`, upserting on `UIMessage.id` and concatenating parts — one
   * user message reaches the channel as one wire message per part, so it can
   * arrive as several inputs sharing that id.
   * @param callback - Called with each foreign input to observe it.
   * @returns An unsubscribe function.
   */
  onForeignInput(callback: (input: VercelInput<TMetadata, TDataParts, TTools>) => void): () => void;
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
 * Reject when a promise has not settled within the bound.
 *
 * The run id arrives over the channel and nothing else bounds that wait: a
 * route that answers 200 and then dies, or an agent that opens its run without
 * threading the triggering input, would otherwise leave the stream open and
 * useChat streaming for ever.
 * @param promise - The promise to bound.
 * @param ms - How long to wait.
 * @returns The promise's value.
 * @throws {@link Ably.ErrorInfo} with {@link ErrorCode.RunResponseStreamFailed} when the bound elapses.
 */
const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Ably.ErrorInfo(
              `unable to stream the run; no run started within ${String(ms)}ms of the send`,
              ErrorCode.RunResponseStreamFailed,
              504,
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Coerce a thrown value into an `Ably.ErrorInfo` without losing it.
 *
 * `errorCause` only propagates a value that is already an `ErrorInfo`, so a
 * plain `Error` — which is what `fetch` and the AI SDK throw — would otherwise
 * reach the consumer as a bare message with no chain. Wrapping it first gives
 * the chain something to carry.
 * @param error - The thrown value.
 * @param code - The code to report when the value is not already an `ErrorInfo`.
 * @param statusCode - The status to report alongside `code`.
 * @param operation - Names the failed operation in the message.
 * @returns The value itself when it is an `ErrorInfo`, otherwise a wrapper carrying it as `cause`.
 */
const asErrorInfo = (error: unknown, code: ErrorCode, statusCode: number, operation: string): Ably.ErrorInfo => {
  if (error instanceof Ably.ErrorInfo) return error;
  const cause = error instanceof Error ? new Ably.ErrorInfo(error.message, code, statusCode) : undefined;
  return new Ably.ErrorInfo(`unable to ${operation}; ${errorMessage(error)}`, code, statusCode, cause);
};

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
  const note = (k: string, serial: string): void => {
    const best = canonical.get(k);
    // Ably serials sort lexicographically, so the highest string is the latest.
    if (best === undefined || serial > best) canonical.set(k, serial);
  };
  for (const event of events) {
    if (event.kind === 'step-lifecycle') {
      // A retained `step-start` is the only evidence a later attempt exists
      // when that attempt's own output is not in the replay yet. Reading only
      // message events would leave the dead attempt looking canonical.
      if (event.event.type === 'step-start' && event.event.serial !== undefined) {
        note(attemptKey(event.event.runId, event.event.stepId), event.event.serial);
      }
      continue;
    }
    if (event.kind !== 'message') continue;
    const { runId, stepId, stepStartSerial } = event.meta;
    if (stepId === undefined || stepStartSerial === undefined) continue;
    note(attemptKey(runId, stepId), stepStartSerial);
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
 * Whether an event is a run's terminal (its `end` or `suspend` lifecycle).
 *
 * Delivering one closes the consumer's stream, so a replay has to order it
 * after everything it should carry.
 * @param event - The adapter event to classify.
 * @returns True when the event ends or suspends its run.
 */
const isRunTerminal = <TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools>(
  event: AdapterEvent<TMetadata, TDataParts, TTools>,
): boolean => event.kind === 'run-lifecycle' && (event.event.type === 'end' || event.event.type === 'suspend');

/**
 * Join two event sequences, dropping any event whose delivery has already been
 * seen. A second walk can put one event in both the retention and the live
 * buffer, and delivering it twice would duplicate its content in the reducer.
 *
 * A message event is keyed on its **version serial**, not its message serial.
 * A streamed message keeps one message serial for its whole life and advances
 * `version.serial` per append, so keying on the message serial would collapse
 * every append of a streaming message to whichever one arrived first —
 * silently dropping the rest of the reply on the path this exists to serve.
 * Lifecycle events carry their own serial and are one delivery each.
 * @param events - The events to join, oldest first.
 * @returns The events with duplicate deliveries removed, order preserved.
 */
const dedupeByDelivery = <TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools>(
  events: AdapterEvent<TMetadata, TDataParts, TTools>[],
): AdapterEvent<TMetadata, TDataParts, TTools>[] => {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = event.kind === 'message' ? (event.meta.versionSerial ?? event.meta.serial) : event.event.serial;
    // Only a locally synthesised event lacks both, and the transport publishes
    // none; keep it rather than treat it as a duplicate.
    if (key === undefined) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * The message a client input names, when it names one.
 *
 * A whole turn IS a message and answers with its own id. An input that amends
 * an existing message carries that message's id in its body. A `regenerate`
 * names a message it does not belong to, so it answers `undefined` and groups
 * with the wire message it arrived on.
 * @param input - The decoded input.
 * @returns The domain message id, or `undefined` when the input names none it belongs to.
 */
const inputMessageId = <TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools>(
  input: VercelInput<TMetadata, TDataParts, TTools>,
): string | undefined => {
  switch (input.kind) {
    case 'message': {
      return input.payload.id;
    }
    case 'chunk':
    case 'approval': {
      return input.payload.messageId;
    }
    default: {
      return undefined;
    }
  }
};

/**
 * The message an output chunk names, when it names one.
 *
 * Only `start` carries the id, which is what makes it the join key for two
 * publishes of one assistant message.
 * @param output - The decoded chunk.
 * @returns The domain message id, or `undefined` for every other chunk.
 */
const outputMessageId = <TMetadata, TDataParts extends AI.UIDataTypes>(
  output: VercelOutput<TMetadata, TDataParts>,
): string | undefined => {
  if (output.type !== 'start') return undefined;
  // `VercelOutput` resolves through `AI.InferUIMessageChunk`, and a conditional
  // type does not narrow its members on `type`, so read the field structurally.
  return 'messageId' in output && typeof output.messageId === 'string' ? output.messageId : undefined;
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
  /** The run ids this adapter is currently streaming, in run-id settle order. */
  private readonly _streamingRunIds = new Set<string>();
  /**
   * Run-id promises for streams opened but not yet settled, in open order.
   *
   * {@link cancel} needs these because a user can press Stop before the
   * `ai-run-start` that names the run has landed. Without them the cancel has
   * no id to address and is silently dropped, leaving the agent generating
   * against a UI that has moved on. `ClientTransport.cancel` accepts the
   * promise and publishes once it settles.
   */
  private readonly _pendingRunIds = new Set<Promise<string>>();

  /**
   * Recent live events, oldest first, bounded by {@link LIVE_BUFFER_LIMIT}.
   *
   * Runs from construction, because the decoder hands each wire message out
   * exactly once and the walk shares it — an event dropped before a collector
   * exists cannot be recovered from history. A reconnect reads its run's
   * events out of here; it never drains the buffer, so a run this client only
   * observed (rather than started) can still be resumed with its opening
   * content intact.
   */
  private readonly _liveBuffer: AdapterEvent<TMetadata, TDataParts, TTools>[] = [];
  /**
   * Events of messages {@link readSince} withheld, keyed by the run that had
   * not ended. Insertion order is load-bearing in two places: the newest key
   * is the run {@link reconnectToStream} resumes, and the oldest is what the
   * retention cap evicts.
   */
  private readonly _retained = new Map<string, AdapterEvent<TMetadata, TDataParts, TTools>[]>();
  /**
   * Every page {@link readSince} has walked so far, oldest first. The
   * underlying pager opens its cursor once and keeps it, so a second walk
   * fetches no pages — without this the re-walk would see an empty channel,
   * report no messages and drop the retention the first walk built.
   */
  private _walkedPages: AdapterEvent<TMetadata, TDataParts, TTools>[] = [];
  /** Whether the walk has reached the start of the channel. */
  private _walkExhausted = false;
  /**
   * Runs seen open on the channel — a `run-lifecycle` start with no end yet,
   * newest last. This is what lets a reconnect go live on a run the walk never
   * saw: the run another participant started after this client hydrated.
   */
  private readonly _unendedRunIds = new Set<string>();

  private readonly _foreign = new Set<(runId: string) => void>();
  private readonly _foreignInputs = new Set<(input: VercelInput<TMetadata, TDataParts, TTools>) => void>();
  /**
   * The transport-message-ids this adapter published, newest last, bounded by
   * {@link OWN_INPUT_ID_LIMIT}.
   *
   * A publish echoes back like any other delivery, and
   * {@link onForeignInput} must not report this client's own turn as another
   * participant's. An id is claimed before its publish rather than read off the
   * publish result, because the echo and the publish acknowledgement are
   * separate deliveries and nothing orders them — an echo that beats the
   * acknowledgement is still recognised.
   */
  private readonly _ownInputIds = new Set<string>();
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

    this._unsubscribe = this._transport.subscribe((event) => {
      this._recordLive(event);
      this._trackOpenRun(event);
      for (const collector of this._collectors) collector(event);
      this._notifyForeignRun(event);
      this._notifyForeignInput(event);
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

  onForeignInput(callback: (input: VercelInput<TMetadata, TDataParts, TTools>) => void): () => void {
    this._foreignInputs.add(callback);
    return () => {
      this._foreignInputs.delete(callback);
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
    this._streamingRunIds.clear();
    this._pendingRunIds.clear();
    this._unendedRunIds.clear();
    this._ownInputIds.clear();
    this._retained.clear();
    this._walkedPages = [];
    this._walkExhausted = false;
    this._liveBuffer.length = 0;
    // Every closer ran `finish()` above, which decremented the counter and
    // emitted the transition at zero, so there is nothing left to reset here.
  }

  async cancel(): Promise<void> {
    this._logger.trace('ChatTransport.cancel();');
    // A settled id first; failing that, the newest stream still waiting for
    // one. Stop pressed before `ai-run-start` lands has to reach the agent
    // too, and the transport publishes the cancel when the promise settles.
    const settled = [...this._streamingRunIds].at(-1);
    const target = settled ?? [...this._pendingRunIds].at(-1);
    if (target === undefined) {
      this._logger.debug('ChatTransport.cancel(); nothing open to cancel');
      return;
    }
    this._logger.debug('ChatTransport.cancel(); cancelling open run', { pending: settled === undefined });
    await this._transport.cancel(target);
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

    // The live buffer has been running since construction, so everything
    // published between attach and here is already held. history() is bounded
    // at the attach point and shares the live decoder, so the buffered events
    // are strictly newer than every page; a re-walk's overlap is removed by
    // delivery at hand-off.

    let all: AdapterEvent<TMetadata, TDataParts, TTools>[] = [...this._walkedPages];
    let exhausted = this._walkExhausted;
    while (!exhausted) {
      const batch = await this._transport.history();
      all = [...batch.events, ...all];
      exhausted = batch.exhausted;
      if (latestSerial !== undefined && this._reached(all, latestSerial)) break;
    }
    // Paging runs backwards, so each batch is prepended and the accumulated
    // set stays chronological.
    this._walkedPages = all;
    this._walkExhausted = exhausted;

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

    const messages = this._groupWalked(walked, openRuns);
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
      [...this._unendedRunIds].findLast((id) => !this._streamingRunIds.has(id));
    if (runId === undefined) {
      this._logger.debug('ChatTransport.reconnectToStream(); nothing to resume');
      // eslint-disable-next-line unicorn/no-null -- null is required by the AI SDK ChatTransport contract
      return null;
    }

    const retained = this._retained.get(runId) ?? [];
    // Only this run's events: the buffer is shared and is not drained, so a
    // later reconnect on another run still finds its own opening content.
    const buffered = this._liveBuffer.filter((event) =>
      event.kind === 'message' ? event.meta.runId === runId : event.event.runId === runId,
    );
    const collector = this._openRunStream();
    this._retained.delete(runId);

    // Replay the withheld message on a reducer that holds nothing for it, then
    // the events the buffer holds. A re-walk can put one event in both, so the
    // two are joined on delivery. The canonical-attempt filter then runs over
    // the whole replay, so a superseded attempt's output never reaches useChat.
    // Awaited so the returned stream already holds its replay: useChat starts
    // reading a stream whose withheld message is buffered, not one that fills
    // in behind it.
    //
    // The retained terminal goes last. A run that ended between the walk and
    // this call has its terminal in both sequences, and delivering a terminal
    // closes the stream — so a straight concatenation would put the retained
    // copy ahead of the live deltas, the dedupe would keep that first copy,
    // and every delta after it would be dropped on a closed stream. Ordering
    // it last means the live copy wins when the buffer holds one, and the
    // retained copy still closes the stream when the buffer has been trimmed.
    const retainedTerminal = retained.filter((event) => isRunTerminal(event));
    const retainedBody = retained.filter((event) => !isRunTerminal(event));
    await collector.awaitRunId(
      runId,
      dropSupersededAttempts(dedupeByDelivery([...retainedBody, ...buffered, ...retainedTerminal])),
    );
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
    const transportMessageId = this._claimInputId();
    return this._send(abortSignal, async () =>
      this._transport.publishInput({ kind: 'message', payload: message }, { transportMessageId }),
    );
  }

  /**
   * Publish one action per resolved tool part on the assistant useChat named,
   * then wake the agent.
   *
   * Each action names the assistant's `UIMessage.id` in its body and carries
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
    // The wire id is minted like any other publish; each action names the
    // assistant it amends inside its own body.
    const transportMessageId = this._claimInputId();
    return this._send(abortSignal, async () => {
      let sent = await this._transport.publishInput(first, { transportMessageId });
      for (const action of rest) {
        sent = await this._transport.publishInput(action, { transportMessageId });
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
    const transportMessageId = this._claimInputId();
    return this._send(abortSignal, async () =>
      this._transport.publishInput({ kind: 'regenerate', payload: { messageId } }, { transportMessageId }),
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
      // whose input-transport-message-id matches this publish. It never comes out
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
              messageId: assistant.id,
              chunk: {
                type: 'tool-output-available',
                toolCallId: part.toolCallId,
                output: part.output,
                ...(part.type === 'dynamic-tool' ? { dynamic: true } : {}),
              },
            },
          });
          break;
        }
        case 'output-error': {
          actions.push({
            kind: 'chunk',
            payload: {
              messageId: assistant.id,
              chunk: {
                type: 'tool-output-error',
                toolCallId: part.toolCallId,
                errorText: part.errorText,
                ...(part.type === 'dynamic-tool' ? { dynamic: true } : {}),
              },
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
        // A suspended run publishes no end, so treating it as open would
        // withhold its message for a stream that can never terminate. Nothing
        // in this adapter suspends a run — every input opens a fresh one — so
        // a suspend means the agent stopped, and the message is the walk's.
        if (event.event.type === 'end' || event.event.type === 'suspend') ended.add(event.event.runId);
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
      this._retain1(
        runId,
        walked.filter((event) => (event.kind === 'message' ? event.meta.runId === runId : event.event.runId === runId)),
      );
    }
  }

  /**
   * Group the walked events by the message they belong to, skipping the
   * withheld runs.
   *
   * Two stages, because neither key works alone. A wire message carries a
   * `transport-message-id` scoped to one publish of one logical message, which
   * groups an assistant turn's `start`, its streams and its `finish`. It does
   * not join two publishes of the SAME assistant message, which is what an
   * approval does: the agent opens the message in one run, and a second run
   * continues it after the decision arrives. So the buckets are joined again on
   * the domain `messageId` their `start` chunk carries.
   *
   * A bucket whose `start` names no message stays on its own, keyed by its wire
   * id. That is honest: a client that joined mid-stream genuinely does not know
   * which message its chunks belong to.
   *
   * Client inputs that name a message land in that message's group. An input
   * that names one this walk never saw becomes its own group, so nothing
   * published is dropped.
   * @param walked - The walked events, oldest first.
   * @param openRuns - The runs whose messages are withheld.
   * @returns The groups, oldest first.
   */
  private _groupWalked(
    walked: AdapterEvent<TMetadata, TDataParts, TTools>[],
    openRuns: Set<string>,
  ): WalkedMessage<TMetadata, TDataParts, TTools>[] {
    const order: string[] = [];
    const buckets = new Map<string, WalkedEvent<TMetadata, TDataParts, TTools>[]>();
    // The domain message id each wire bucket turned out to belong to.
    const domainOf = new Map<string, string>();

    const push = (key: string, entry: WalkedEvent<TMetadata, TDataParts, TTools>): void => {
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        order.push(key);
        buckets.set(key, [entry]);
        return;
      }
      bucket.push(entry);
    };

    for (const event of dropSupersededAttempts(walked)) {
      if (event.kind !== 'message') continue;
      const { transportMessageId, runId } = event.meta;
      if (transportMessageId === undefined) continue;
      if (runId !== undefined && openRuns.has(runId)) continue;

      for (const input of event.inputs) {
        // An input that amends an existing message names it in its own body,
        // so it groups with that message rather than with the wire message it
        // arrived on. A whole client turn IS a message and keys on its own id.
        const named = inputMessageId(input);
        push(named ?? transportMessageId, { direction: 'input', event: input });
      }
      for (const output of event.outputs) {
        push(transportMessageId, { direction: 'output', event: output });
        // `start` is the only chunk that names the message, so remember it for
        // the join below. First writer wins: a re-`start` of the same wire
        // bucket cannot rename what the earlier chunks already belong to.
        const named = outputMessageId(output);
        if (named !== undefined && !domainOf.has(transportMessageId)) domainOf.set(transportMessageId, named);
      }
    }

    // Join the wire buckets that turned out to be one message, keeping each
    // message at the position its oldest bucket held.
    const groups: WalkedMessage<TMetadata, TDataParts, TTools>[] = [];
    const byId = new Map<string, WalkedMessage<TMetadata, TDataParts, TTools>>();
    for (const key of order) {
      const id = domainOf.get(key) ?? key;
      const existing = byId.get(id);
      const events = buckets.get(key) ?? [];
      if (existing === undefined) {
        const group = { id, events };
        byId.set(id, group);
        groups.push(group);
        continue;
      }
      existing.events.push(...events);
    }
    this._logger.debug('ChatTransport.readSince(); grouped', { groups: groups.length });
    return groups;
  }

  // -------------------------------------------------------------------------
  // Private: streaming
  // -------------------------------------------------------------------------

  /**
   * Retain one run's events for a later replay, re-seating the key as newest
   * and evicting past the bound.
   *
   * Insertion order is load-bearing: the newest key is the run
   * {@link reconnectToStream} resumes, and the oldest is what the cap evicts.
   * @param runId - The run the events belong to.
   * @param events - Its events, oldest first.
   */
  private _retain1(runId: string, events: AdapterEvent<TMetadata, TDataParts, TTools>[]): void {
    this._retained.delete(runId);
    this._retained.set(runId, events);
    while (this._retained.size > RETAINED_RUN_LIMIT) {
      const oldest = this._retained.keys().next();
      if (oldest.done === true) break;
      this._retained.delete(oldest.value);
    }
  }

  /**
   * Hold a live event for a later replay, dropping the oldest past the bound.
   * @param event - The classified transport event.
   */
  private _recordLive(event: AdapterEvent<TMetadata, TDataParts, TTools>): void {
    this._liveBuffer.push(event);
    if (this._liveBuffer.length > LIVE_BUFFER_LIMIT) this._liveBuffer.shift();
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
    if (type === 'end' || type === 'suspend') {
      this._unendedRunIds.delete(runId);
      // Keep the retention and append the terminal rather than dropping it: a
      // run that ends between the walk and the reconnect still has a withheld
      // message to deliver, and replaying its own end is what closes that
      // stream.
      const retained = this._retained.get(runId);
      if (retained) retained.push(event);
      return;
    }
    // Re-seat the id so the set's iteration order stays newest-last.
    this._unendedRunIds.delete(runId);
    this._unendedRunIds.add(runId);
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
    if (this._streamingRunIds.has(runId)) return;
    for (const callback of this._foreign) {
      try {
        callback(runId);
      } catch (error) {
        this._logger.error('ChatTransport._notifyForeignRun(); callback threw', { error });
      }
    }
  }

  /**
   * Tell the foreign-input subscribers about an input another participant
   * published.
   *
   * The `_ownInputIds` check is exact, so this needs no idle gate of its own:
   * the client's own turn is suppressed by id, and a turn another participant
   * sends while this one is streaming still reaches the application.
   * @param event - The classified transport event.
   */
  private _notifyForeignInput(event: AdapterEvent<TMetadata, TDataParts, TTools>): void {
    if (this._foreignInputs.size === 0) return;
    if (event.kind !== 'message' || event.inputs.length === 0) return;
    const { transportMessageId } = event.meta;
    if (transportMessageId !== undefined && this._ownInputIds.has(transportMessageId)) return;
    for (const input of event.inputs) {
      for (const callback of this._foreignInputs) {
        try {
          callback(input);
        } catch (error) {
          this._logger.error('ChatTransport._notifyForeignInput(); callback threw', { error });
        }
      }
    }
  }

  /**
   * Settle the transport-message-id a send publishes under, and remember it as
   * this adapter's own so {@link onForeignInput} does not report the echo.
   *
   * Re-seats an id already held so the set's iteration order stays newest-last,
   * which is what the cap evicts from.
   * @param transportMessageId - The id the send path already addresses, when it has one.
   * @returns The id to publish under.
   */
  private _claimInputId(transportMessageId?: string): string {
    const id = transportMessageId ?? crypto.randomUUID();
    this._ownInputIds.delete(id);
    this._ownInputIds.add(id);
    while (this._ownInputIds.size > OWN_INPUT_ID_LIMIT) {
      const oldest = this._ownInputIds.values().next();
      if (oldest.done === true) break;
      this._ownInputIds.delete(oldest.value);
    }
    return id;
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
    // The unsettled run-id promise, so `cancel()` can address this stream
    // before its `ai-run-start` arrives.
    let pendingRunId: Promise<string> | undefined;
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
      if (runId !== undefined) this._streamingRunIds.delete(runId);
      if (pendingRunId !== undefined) this._pendingRunIds.delete(pendingRunId);
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
        this._retain1(id, [...delivered, event]);
        finish();
        controller?.error(
          new Ably.ErrorInfo(
            `unable to continue the stream; step ${event.event.stepId} was superseded by a later attempt`,
            ErrorCode.Conflict,
            409,
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
        // Bounded: until the run is named there is no terminal to close on, so
        // an unbounded buffer would grow for as long as the wait lasts.
        buffered.push(event);
        if (buffered.length > LIVE_BUFFER_LIMIT) buffered.shift();
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
          if (pendingRunId !== undefined) {
            this._pendingRunIds.delete(pendingRunId);
            pendingRunId = undefined;
          }
          if (closed) return;
          runId = resolved;
          this._streamingRunIds.add(resolved);
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
        pendingRunId = id;
        this._pendingRunIds.add(id);
        // A run that never starts must fail the stream rather than hang it.
        // This promise settles either way: it is a flush barrier, not an error
        // channel, and the failure reaches the consumer on the stream.
        let resolved: string;
        try {
          resolved = await withTimeout(id, RUN_ID_TIMEOUT_MS);
        } catch (error) {
          if (closed) return;
          this._logger.error('ChatTransport._openRunStream(); run never started, failing stream', { error });
          finish();
          // Not a send failure: the publish and the POST both succeeded and
          // the run never started, which is the run's response stream failing
          // before it produced anything.
          controller?.error(asErrorInfo(error, ErrorCode.RunResponseStreamFailed, 500, 'stream the run'));
          return;
        }
        settle(resolved);
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
      // `fetch` rejects with a plain TypeError whose own `cause` carries the
      // transport reason (ECONNREFUSED, DNS, and so on), and `errorCause` drops
      // anything that is not already an ErrorInfo — so wrap rather than lose it.
      throw asErrorInfo(error, ErrorCode.SessionSendFailed, 500, `send; the POST to ${this._api} failed`);
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
