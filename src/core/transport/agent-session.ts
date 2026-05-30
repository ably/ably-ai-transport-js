/**
 * Core agent (server-side) session, parameterized by codec.
 *
 * Composes RunManager and pipeStream to handle the full server-side run
 * lifecycle. Cancel message routing is handled directly by the session's
 * single channel subscription — no separate cancel manager needed.
 *
 * The session exposes a single factory method — `createRun()` — which returns
 * a Run object with explicit lifecycle methods: start(), addMessages(),
 * pipe(), and end().
 */

import * as Ably from 'ably';

import {
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { getTransportHeaders, mergeHeaders } from '../../utils.js';
import { registerAgent } from '../agent.js';
import type { Codec, CodecInputEvent, CodecOutputEvent, WriteOptions } from '../codec/types.js';
import { buildTransportHeaders } from './headers.js';
import { Invocation } from './invocation.js';
import { pipeStream } from './pipe-stream.js';
import type { RunManager } from './run-manager.js';
import { createRunManager } from './run-manager.js';
import type {
  AddMessageOptions,
  AddMessagesResult,
  AgentSession,
  AgentSessionOptions,
  CancelRequest,
  EventsNode,
  LoadConversationOptions,
  MessageNode,
  PipeOptions,
  Run,
  RunEndReason,
  RunRuntime,
  RunView,
  StreamResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Run-state lookup helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared wire-message helpers
// ---------------------------------------------------------------------------

/**
 * Compare two Ably messages by serial for chronological ordering (oldest first).
 * Messages without a serial sort last.
 * @param a - First message.
 * @param b - Second message.
 * @returns Negative if a is older, positive if b is older, 0 if equal.
 */
const bySerial = (a: Ably.InboundMessage, b: Ably.InboundMessage): number => {
  if (a.serial === undefined && b.serial === undefined) return 0;
  if (a.serial === undefined) return 1;
  if (b.serial === undefined) return -1;
  return a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0;
};

/**
 * Merge live-observed messages into a collection of history messages, then
 * return a deduplicated, chronologically sorted array.
 *
 * History messages take priority in deduplication (history serial wins if the
 * same message appears in both). Messages without a serial are dropped because
 * they cannot be reliably ordered.
 * @param collected - Raw messages from channel.history (any order).
 * @param live - Messages observed live (e.g. by the input-event lookup); may be undefined.
 * @returns Deduplicated, chronologically sorted messages.
 */
const withLiveMessages = (
  collected: readonly Ably.InboundMessage[],
  live: readonly Ably.InboundMessage[] | undefined,
): Ably.InboundMessage[] => {
  const seen = new Set<string>();
  const result: Ably.InboundMessage[] = [];
  for (const msg of collected) {
    if (msg.serial !== undefined && !seen.has(msg.serial)) {
      seen.add(msg.serial);
      result.push(msg);
    }
  }
  if (live !== undefined) {
    for (const msg of live) {
      if (msg.serial !== undefined && !seen.has(msg.serial)) {
        seen.add(msg.serial);
        result.push(msg);
      }
    }
  }
  return result.toSorted(bySerial);
};

/**
 * Fold a pre-sorted array of wire messages for a single run into a projection.
 *
 * Skips lifecycle events (`ai-run-start`, `ai-run-end`) and stops before the
 * message whose `codec-message-id` equals `truncateAt` (exclusive —
 * that message is not folded). Used by both `loadRunProjection` (no truncation)
 * and `loadConversation` (ancestor truncation for regenerate / fork).
 * @param codec - Codec used to decode and fold events.
 * @param sortedMessages - Chronologically ordered wire messages (all runs).
 * @param runId - Only messages stamped with this run-id are folded.
 * @param truncateAt - Stop before this codec-message-id; omit to fold all messages.
 * @returns The projection and the count of messages that were folded.
 */
const foldRunMessages = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  codec: Codec<TInput, TOutput, TProjection, TMessage>,
  sortedMessages: readonly Ably.InboundMessage[],
  runId: string,
  truncateAt?: string,
): { projection: TProjection; folded: number } => {
  const decoder = codec.createDecoder();
  let projection = codec.init();
  let folded = 0;
  for (const msg of sortedMessages) {
    const h = getTransportHeaders(msg);
    if (h[HEADER_RUN_ID] !== runId) continue;
    // Lifecycle events carry no codec content — skip them.
    if (msg.name === EVENT_RUN_START || msg.name === EVENT_RUN_END) continue;
    const codecMsgId = h[HEADER_CODEC_MESSAGE_ID];
    if (truncateAt !== undefined && codecMsgId === truncateAt) break;
    const { inputs, outputs } = decoder.decode(msg);
    const events: (TInput | TOutput)[] = [...inputs, ...outputs];
    const routingCodecMessageId = codecMsgId ?? '';
    for (const event of events) {
      projection = codec.fold(projection, event, { serial: msg.serial ?? '', messageId: routingCodecMessageId });
    }
    folded++;
  }
  return { projection, folded };
};

// ---------------------------------------------------------------------------
// Run-state lookup helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all messages on the channel that belong to `runId`, decode them
 * through the codec, and fold them into a single projection. Used by the
 * agent to reconstruct the run's full state — including client-published
 * tool-output amends — when resuming a suspended run in a fresh agent
 * session.
 *
 * Doesn't require channel rewind: an explicit `channel.history()` call
 * returns the same data even if the channel is already attached from a
 * prior session.
 * @param opts - Load parameters.
 * @param opts.channel - The Ably channel to read history from.
 * @param opts.codec - Codec used to decode and fold events.
 * @param opts.runId - Run identifier whose events should be folded.
 * @param opts.signal - AbortSignal that cancels the wait when the run is cancelled.
 * @param opts.logger - Optional logger for diagnostic output.
 * @param opts.liveMessages - Raw Ably messages already observed live (e.g. by
 *   the input-event lookup). Folded alongside the history fetch so just-published
 *   client wires don't depend on Ably's history-indexing window.
 * @returns The projection produced by folding all run events in serial order.
 */
const loadRunProjection = async <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(opts: {
  channel: Ably.RealtimeChannel;
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  runId: string;
  signal: AbortSignal;
  logger: Logger | undefined;
  /**
   * Wires the agent already observed live via the input-event lookup channel
   * subscription. Folded alongside the history fetch so that the
   * just-published client wires (e.g. a tool-output-available
   * continuation) are guaranteed to land in the projection even if Ably
   * has not yet indexed them into channel.history.
   */
  liveMessages?: readonly Ably.InboundMessage[];
}): Promise<TProjection> => {
  const { channel, codec, runId, signal, logger, liveMessages } = opts;

  if (signal.aborted) {
    throw new Ably.ErrorInfo(
      `unable to load run projection; run ${runId} was cancelled`,
      ErrorCode.InvalidArgument,
      400,
    );
  }

  await channel.attach();

  // No `untilAttach` — we need messages published AFTER the channel first
  // attached (e.g. client-published tool-output amends on a suspended run
  // that this agent session is resuming).
  const wirePerPage = 200;
  const collected: Ably.InboundMessage[] = [];
  let page = await channel.history({ limit: wirePerPage });
  collected.push(...page.items);
  // Bound page-walk so a long-lived channel doesn't exhaust memory on
  // resume. 2000 wire messages is generously more than any single run
  // could possibly produce.
  const collectedCap = 2000;
  while (page.hasNext() && collected.length < collectedCap) {
    const nextPage: Ably.PaginatedResult<Ably.InboundMessage> | null = await page.next();
    if (!nextPage) break;
    collected.push(...nextPage.items);
    page = nextPage;
  }

  const sorted = withLiveMessages(collected, liveMessages);
  const { projection, folded } = foldRunMessages(codec, sorted, runId);

  logger?.debug('loadRunProjection(); folded run events', { runId, folded });
  return projection;
};

/**
 * Wait for every event-id in `expectedInputEventIds` to arrive as a channel
 * message before letting the run proceed to LLM work. Uses the session's
 * unfiltered channel dispatcher (registered in `connect()`) so that
 * messages replayed via channel rewind on attach reach the lookup — no
 * separate history fetch needed.
 *
 * Scope: this awaits the data-carrying input events a send publishes —
 * fresh prompts, edits, regenerates, tool results, and approvals. Control
 * events (cancel etc.) carry no `event-id`, are dispatched
 * separately, and never enter this lookup.
 *
 * Each client-published event in a send (user-message AND amend events
 * such as tool-approval responses and client tool outputs) is stamped
 * with its own `event-id`.
 * The lookup matches incoming messages against the expected set; ids
 * not in the set are ignored, duplicates (rewind redelivering a message
 * also seen live) are deduped by event-id. The wait completes when
 * every expected id has arrived, guaranteeing the channel state is
 * consistent with what the client promised before any downstream
 * processing (loadProjection, streamText) runs.
 *
 * User-message arrivals decode into MessageNodes that populate
 * `run.view.messages`; amend arrivals fold into a fresh projection that
 * has no target message, so they're orphaned and dropped — they only
 * count toward the wait. Collected nodes are returned sorted by Ably
 * `serial` ascending.
 *
 * Bounded by `timeoutMs` as a total budget across all N arrivals. The
 * caller's `signal` aborts the wait. On partial collection at timeout the
 * promise rejects with `InputEventNotFound` and an error message including
 * "received X of Y". If any decode throws mid-collection, the whole lookup
 * rejects with `InputEventNotFound` wrapping the decode error as cause —
 * already-collected messages are discarded.
 * @param opts - Lookup parameters.
 * @param opts.register - Session-provided registration that delivers input events for this invocationId. Returns an unregister function.
 * @param opts.codec - Codec used to decode arriving messages.
 * @param opts.invocationId - Invocation identifier the dispatcher keys on.
 * @param opts.runId - Run identifier (used for logging and error messages).
 * @param opts.expectedInputEventIds - Input-event ids the lookup must observe before resolving.
 * @param opts.timeoutMs - Maximum total time to wait for all event-id arrivals.
 * @param opts.signal - AbortSignal that cancels the wait when the run is cancelled.
 * @param opts.logger - Optional logger for diagnostic output.
 * @returns The MessageNodes for arriving user-message events (sorted by Ably
 *   serial — empty when every input event was a tool-resolution wire message that
 *   decoded to a chunk and produced no node), and the transport headers of
 *   the first matched wire message. `firstHeaders` is the canonical source for
 *   run-level metadata (clientId, parent, forkOf, continuation flag) because
 *   it lands whether or not the decode produced a MessageNode. `firstClientId`
 *   carries the publisher's Ably-level `clientId` from that same message — the
 *   source of `inputClientId` re-stamping on the agent's published events.
 */
interface InputEventLookupResult<TMessage> {
  nodes: MessageNode<TMessage>[];
  firstHeaders?: Record<string, string>;
  firstClientId?: string;
  /**
   * Raw Ably messages observed live for the matched input-event ids, in
   * arrival order. The agent forwards these to `loadRunProjection` so a
   * continuation invocation can fold the just-published client wires
   * (e.g. a tool-output-available) without waiting on Ably's channel
   * history indexing window.
   */
  rawMessages: Ably.InboundMessage[];
}

const lookupInputEvents = async <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(opts: {
  register: (callback: (msg: Ably.InboundMessage) => void) => () => void;
  codec: import('../codec/types.js').Codec<TInput, TOutput, TProjection, TMessage>;
  invocationId: string;
  runId: string;
  expectedInputEventIds: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
  logger: Logger | undefined;
}): Promise<InputEventLookupResult<TMessage>> => {
  const { register, codec, invocationId, runId, expectedInputEventIds, timeoutMs, signal, logger } = opts;
  const expectedSet = new Set(expectedInputEventIds);
  const expectedCount = expectedSet.size;

  /**
   * Decode an inbound Ably message into MessageNodes via the codec.
   * @param m - The inbound Ably message to decode.
   * @returns The decoded MessageNodes carrying transport headers and serial.
   */
  const collected: MessageNode<TMessage>[] = [];
  const rawMessages: Ably.InboundMessage[] = [];
  const matchedInputEventIds = new Set<string>();
  let firstHeaders: Record<string, string> | undefined;
  let firstClientId: string | undefined;

  const decode = (m: Ably.InboundMessage): MessageNode<TMessage>[] => {
    const decoder = codec.createDecoder();
    const headers = getTransportHeaders(m);
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID] ?? '';
    const { inputs, outputs } = decoder.decode(m);
    const events: (TInput | TOutput)[] = [...inputs, ...outputs];
    let projection = codec.init();
    for (const event of events) {
      projection = codec.fold(projection, event, { serial: m.serial ?? '', messageId: codecMessageId });
    }
    return codec.getMessages(projection).map((message) => ({
      kind: 'message' as const,
      message,
      codecMessageId,
      parentId: headers[HEADER_PARENT],
      forkOf: headers[HEADER_FORK_OF],
      headers,
      serial: m.serial,
    }));
  };

  return new Promise<InputEventLookupResult<TMessage>>((resolve, reject) => {
    let settled = false;
    // Dedupe across rewind-redelivery: rewind may surface a message the
    // listener also saw live. Scoped to the active lookup so it cannot
    // grow unbounded.
    const seenSerials = new Set<string>();
    // Forward-declared so that cleanup() and onCancelled() can reference them
    // before they are assigned. cleanup may run synchronously inside
    // `register(...)` (when buffered input events drain on registration) before
    // `unregister`/`timer` have been assigned — the no-op fallback for
    // unregister and undefined-guard for timer handle that window. The
    // settled-flag re-check after `register` returns reconciles the
    // listener-detach that cleanup couldn't perform inside that window.
    /* eslint-disable prefer-const, unicorn/consistent-function-scoping, @typescript-eslint/no-empty-function -- forward-declared state for the sync-drain reconciliation pattern; see comment above. */
    let unregister: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    /* eslint-enable */
    const cleanup = (): void => {
      unregister();
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onCancelled);
    };
    const onCancelled = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Ably.ErrorInfo(`unable to look up input event; run ${runId} was cancelled`, ErrorCode.InvalidArgument, 400),
      );
    };
    signal.addEventListener('abort', onCancelled, { once: true });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- onCancelled may have settled the promise synchronously above when the signal was already aborted.
    if (settled) return;
    unregister = register((m) => {
      if (settled) return;
      if (m.serial !== undefined && seenSerials.has(m.serial)) return;
      if (m.serial !== undefined) seenSerials.add(m.serial);

      const wireHeaders = getTransportHeaders(m);

      // Only count messages whose event-id is in the expected set.
      const msgEventId = wireHeaders[HEADER_EVENT_ID];
      if (!msgEventId || !expectedSet.has(msgEventId) || matchedInputEventIds.has(msgEventId)) return;
      matchedInputEventIds.add(msgEventId);

      // Capture the trigger event's headers AND its Ably channel-level `clientId`
      // so run-level metadata (parent / forkOf / continuation flag from headers;
      // `inputClientId` from the wire publisher) is available even when the decode
      // produces zero MessageNodes — the case for continuation tool-resolution
      // trigger events whose chunks fold into a fresh empty projection without
      // an assistant to land on.
      if (firstHeaders === undefined) {
        firstHeaders = wireHeaders;
        firstClientId = m.clientId;
      }

      let decoded: MessageNode<TMessage>[];
      try {
        decoded = decode(m);
      } catch (error) {
        settled = true;
        cleanup();
        const cause = error instanceof Ably.ErrorInfo ? error : undefined;
        reject(
          new Ably.ErrorInfo(
            `unable to look up input event; decode failed for invocation ${invocationId}: ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.InputEventNotFound,
            504,
            cause,
          ),
        );
        return;
      }
      for (const node of decoded) collected.push(node);
      rawMessages.push(m);
      if (matchedInputEventIds.size < expectedCount) return;
      settled = true;
      cleanup();
      // Sort by Ably serial ascending so callers see publish order regardless
      // of interleaved rewind+live delivery. Null serials sort last (defensive
      // — input events should always carry a serial).
      collected.sort((a, b) => {
        if (a.serial === undefined && b.serial === undefined) return 0;
        if (a.serial === undefined) return 1;
        if (b.serial === undefined) return -1;
        if (a.serial < b.serial) return -1;
        if (a.serial > b.serial) return 1;
        return 0;
      });
      logger?.debug('lookupInputEvents(); collected input events', {
        runId,
        invocationId,
        count: collected.length,
      });
      resolve({ nodes: collected, firstHeaders, firstClientId, rawMessages });
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the register callback may have settled the promise synchronously during buffered input-event drain.
    if (settled) {
      // Sync drain inside register settled the promise; cleanup ran but
      // could not detach the listener because `unregister` was still the
      // no-op. Detach it now.
      unregister();
      return;
    }
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Ably.ErrorInfo(
          `unable to look up input event; received ${String(collected.length)} of ${String(expectedCount)} input events for invocation ${invocationId} within ${String(timeoutMs)}ms`,
          ErrorCode.InputEventNotFound,
          504,
        ),
      );
    }, timeoutMs);
  });
};

// ---------------------------------------------------------------------------
// Internal run record for cancel routing
// ---------------------------------------------------------------------------

interface RegisteredRun {
  runId: string;
  /** Invocation-id this run is associated with, sourced from the invocation's `invocationId`. */
  invocationId: string;
  controller: AbortController;
  /** Composite signal that fires when either the internal controller or the external signal aborts. */
  signal: AbortSignal;
  onCancel?: (request: CancelRequest) => Promise<boolean>;
  onError?: (error: Ably.ErrorInfo) => void;
}

// ---------------------------------------------------------------------------
// Internal state machines
// ---------------------------------------------------------------------------

enum SessionState {
  READY = 'ready',
  CLOSED = 'closed',
}

enum RunState {
  INITIALIZED = 'initialized',
  STARTED = 'started',
  ENDED = 'ended',
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-ST1
class DefaultAgentSession<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements AgentSession<TInput, TOutput, TProjection, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: AgentSessionOptions<TInput, TOutput, TProjection, TMessage>['codec'];
  private readonly _logger: Logger | undefined;
  private readonly _onError: ((error: Ably.ErrorInfo) => void) | undefined;
  private readonly _runManager: RunManager;
  private readonly _registeredRuns = new Map<string, RegisteredRun>();
  /**
   * Active input-event lookups keyed by invocation-id. The channel listener
   * dispatches matching user messages to these callbacks so that messages
   * replayed via channel rewind (and live messages alike) reach the right
   * lookup without each lookup having to subscribe separately.
   */
  private readonly _pendingInputEventLookups = new Map<string, (msg: Ably.InboundMessage) => void>();
  /**
   * Input events buffered by invocation-id when no lookup callback
   * was registered at delivery time. Each invocation-id maps to an ordered
   * array because a single multi-message `send()` publishes N Ably messages
   * sharing one invocation-id. Rewind replays user messages on attach —
   * before `run.start()` runs — so without buffering they would be dropped.
   * `_registerInputEventListener` drains the buffer on registration. FIFO
   * eviction at `_inputEventBufferLimit` invocation entries (each entry counts
   * once regardless of array length).
   */
  private readonly _inputEventBuffer = new Map<string, Ably.InboundMessage[]>();
  private readonly _inputEventBufferLimit: number;
  /**
   * Bounded FIFO map of invocation-ids whose lookup has resolved
   * successfully, valued by the number of event-ids the lookup resolved at.
   * Used to distinguish over-arrival (extra input event for a lookup that
   * already completed with N event-ids) from a genuine late /
   * never-claimed arrival, so we can warn loudly on the former (with the
   * count the client claimed) without spamming on the latter. Reject paths
   * do not populate this map — their cause is already surfaced via the
   * rejection.
   */
  private readonly _completedLookupInvocationIds = new Map<string, number>();
  private readonly _completedLookupInvocationIdsLimit = 256;
  private readonly _channelListener: (msg: Ably.InboundMessage) => void;
  private readonly _inputEventLookupTimeoutMs: number;

  private _state = SessionState.READY;
  private _connectPromise: Promise<void> | undefined;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  constructor(options: AgentSessionOptions<TInput, TOutput, TProjection, TMessage>) {
    // Spec: AIT-ST1a, AIT-ST1a2 — register this SDK on both the connection
    // (options.agents) and channel-attach (params.agent) paths. Idempotent
    // across sessions sharing one client.
    const registerOptions = registerAgent(options.client);
    // Attach with a rewind window (default 2m) so a freshly-constructed
    // agent session can locate an input event that was published before it
    // attached (closes the lookup race when a per-request agent is spun
    // up after the client has already POSTed). Tunable via
    // `AgentSessionOptions.rewindWindow`.
    const channelOptions: Ably.ChannelOptions = {
      params: { ...registerOptions.params, rewind: options.rewindWindow ?? '2m' },
    };
    this._channel = options.client.channels.get(options.channelName, channelOptions);
    this._codec = options.codec;
    this._logger = options.logger?.withContext({ component: 'AgentSession' });
    this._onError = options.onError;
    this._runManager = createRunManager(this._channel, this._logger);
    this._inputEventLookupTimeoutMs = options.inputEventLookupTimeoutMs ?? 30000;
    this._inputEventBufferLimit = options.inputEventBufferLimit ?? 200;

    this._channelListener = (msg: Ably.InboundMessage) => {
      this._handleChannelMessage(msg);
    };

    // Spec: AIT-ST12, AIT-ST12a
    // Listen for channel state changes that break message continuity. The
    // session only consumes cancel messages from the channel, so losing one
    // is survivable — but the developer needs to know so they can decide
    // whether to cancel in-flight work. _hasAttachedOnce is seeded from the
    // channel's current state so pre-attached channels are handled correctly;
    // it distinguishes the initial attach from a genuine discontinuity.
    this._hasAttachedOnce = this._channel.state === 'attached';
    this._onChannelStateChange = (stateChange: Ably.ChannelStateChange) => {
      this._handleChannelStateChange(stateChange);
    };
    this._channel.on(this._onChannelStateChange);

    this._logger?.debug('DefaultAgentSession(); session created');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  // Spec: AIT-ST2
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- preserve reference equality across calls
  connect(): Promise<void> {
    if (this._state === SessionState.CLOSED) {
      return Promise.reject(new Ably.ErrorInfo('unable to connect; session is closed', ErrorCode.SessionClosed, 400));
    }
    if (this._connectPromise) return this._connectPromise;

    this._logger?.trace('DefaultAgentSession.connect();');
    // Subscribe unfiltered (before attach, per RTL7g — subscribe implicitly
    // attaches the channel). An unfiltered subscribe ensures that messages
    // replayed via channel rewind reach the dispatcher so input-event
    // lookups can match against them; the dispatcher then routes by name
    // (cancel vs. input event). A name-filtered subscribe would silently
    // drop replayed user messages because rewind delivers them to listeners
    // registered at attach time only.
    this._connectPromise = this._channel.subscribe(this._channelListener).then(
      () => {
        this._logger?.debug('DefaultAgentSession.connect(); subscribed and attached');
      },
      (error: unknown) => {
        const errInfo = new Ably.ErrorInfo(
          `unable to subscribe to channel; ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.SessionSubscriptionError,
          500,
          error instanceof Ably.ErrorInfo ? error : undefined,
        );
        this._logger?.error('DefaultAgentSession.connect(); subscribe failed');
        this._onError?.(errInfo);
        throw errInfo;
      },
    );
    return this._connectPromise;
  }

  /**
   * Register a callback to receive input events with the given
   * `invocationId`. Lookups must share the session's unfiltered
   * subscription rather than registering their own subscribe — Ably's
   * rewind only delivers to listeners present at attach time.
   *
   * The listener remains registered after the initial buffer drain so
   * subsequent live arrivals reach the lookup until it unregisters itself.
   * Multi-message `send()` relies on this: the buffer may hold K of N
   * messages on register, with the remaining N-K arriving live.
   * @param invocationId - The invocation-id this listener cares about.
   * @param callback - Invoked once per matching Ably message, in buffer-insertion order for drained entries.
   * @returns Unregister function. Safe to call multiple times.
   */
  private _registerInputEventListener(invocationId: string, callback: (msg: Ably.InboundMessage) => void): () => void {
    this._pendingInputEventLookups.set(invocationId, callback);
    // Drain any buffered input events for this invocation-id —
    // rewind replays user messages on attach before run.start() can
    // register the callback. Without this drain, the lookup waits the
    // full `inputEventLookupTimeoutMs` for a live arrival that never comes.
    const buffered = this._inputEventBuffer.get(invocationId);
    if (buffered) {
      this._inputEventBuffer.delete(invocationId);
      for (const m of buffered) callback(m);
    }
    return () => {
      if (this._pendingInputEventLookups.get(invocationId) === callback) {
        this._pendingInputEventLookups.delete(invocationId);
      }
    };
  }

  /**
   * Record an invocation-id whose lookup has resolved successfully so a
   * subsequent unmatched arrival for the same invocation-id can be flagged
   * as an over-arrival (client published more input events than the
   * invocation's `inputEventIds` listed). Bounded FIFO eviction at
   * `_completedLookupInvocationIdsLimit`.
   * @param invocationId - The invocation-id whose lookup just completed.
   * @param expectedCount - The number of event-ids the lookup resolved at — surfaced in the over-arrival warn.
   */
  private _recordCompletedLookup(invocationId: string, expectedCount: number): void {
    if (this._completedLookupInvocationIds.has(invocationId)) return;
    if (this._completedLookupInvocationIds.size >= this._completedLookupInvocationIdsLimit) {
      const oldest = this._completedLookupInvocationIds.keys().next().value;
      if (oldest !== undefined) this._completedLookupInvocationIds.delete(oldest);
    }
    this._completedLookupInvocationIds.set(invocationId, expectedCount);
  }

  // Spec: AIT-ST3
  createRun(invocation: Invocation, runtime?: RunRuntime<TOutput>): Run<TInput, TOutput, TProjection, TMessage> {
    this._logger?.trace('DefaultAgentSession.createRun();', { runId: invocation.runId });
    return this._createRun(invocation, runtime ?? {});
  }

  // Spec: AIT-ST11
  close(): void {
    if (this._state === SessionState.CLOSED) return;
    this._state = SessionState.CLOSED;
    this._logger?.trace('DefaultAgentSession.close();');
    if (this._connectPromise) {
      this._channel.unsubscribe(this._channelListener);
    }
    this._channel.off(this._onChannelStateChange);
    for (const reg of this._registeredRuns.values()) {
      reg.controller.abort();
    }
    this._registeredRuns.clear();
    this._pendingInputEventLookups.clear();
    this._inputEventBuffer.clear();
    this._completedLookupInvocationIds.clear();
    this._runManager.close();
    this._logger?.debug('DefaultAgentSession.close(); session closed');
  }

  // -------------------------------------------------------------------------
  // Cancel message routing
  // -------------------------------------------------------------------------

  private async _handleCancelMessage(msg: Ably.InboundMessage): Promise<void> {
    const headers = getTransportHeaders(msg);
    const runId = headers[HEADER_RUN_ID];

    // Malformed cancel: drop with warn. The protocol requires a single
    // `run-id` header identifying the target run.
    if (!runId) {
      this._logger?.warn('DefaultAgentSession._handleCancelMessage(); missing run-id header', {
        serial: msg.serial,
      });
      return;
    }

    const reg = this._registeredRuns.get(runId);
    if (!reg) return;

    this._logger?.debug('DefaultAgentSession._handleCancelMessage(); matched run', { runId });

    const request: CancelRequest = { message: msg, runId };

    try {
      if (reg.onCancel) {
        const allowed = await reg.onCancel(request);
        if (!allowed) {
          this._logger?.debug('DefaultAgentSession._handleCancelMessage(); cancel rejected by onCancel', {
            runId,
          });
          return;
        }
      }
      reg.controller.abort();
      this._logger?.debug('DefaultAgentSession._handleCancelMessage(); run cancelled', { runId });
    } catch (error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to process cancel for run ${runId}; onCancel handler threw: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.CancelListenerError,
        500,
        error instanceof Ably.ErrorInfo ? error : undefined,
      );
      this._logger?.error('DefaultAgentSession._handleCancelMessage(); onCancel threw', { runId });
      (reg.onError ?? this._onError)?.(errInfo);
    }
  }

  // -------------------------------------------------------------------------
  // Channel state change handler
  // -------------------------------------------------------------------------

  // Spec: AIT-ST12, AIT-ST12a
  private _handleChannelStateChange(stateChange: Ably.ChannelStateChange): void {
    if (this._state === SessionState.CLOSED) return;

    const { current, resumed } = stateChange;

    // Track the initial attach so we don't treat it as a discontinuity
    if (current === 'attached' && !this._hasAttachedOnce) {
      this._hasAttachedOnce = true;
      return;
    }

    // Continuity-breaking states:
    // - FAILED, SUSPENDED, DETACHED: no more messages expected (or gap)
    // - ATTACHED with resumed: false (UPDATE): messages were lost
    const continuityLost =
      current === 'failed' || current === 'suspended' || current === 'detached' || (current === 'attached' && !resumed);

    if (!continuityLost) return;

    this._logger?.error('DefaultAgentSession._handleChannelStateChange(); channel continuity lost', {
      current,
      resumed,
      previous: stateChange.previous,
    });

    const err = new Ably.ErrorInfo(
      `unable to deliver cancel messages; channel continuity lost (${current}${current === 'attached' ? ', resumed: false' : ''})`,
      ErrorCode.ChannelContinuityLost,
      500,
      stateChange.reason,
    );

    // Session-level notification only: continuity loss is not scoped to any
    // run. Per-run onError handlers are reserved for errors from that run's
    // own operations (publish failures, encoder errors). Developers that need
    // per-run reaction can iterate active runs from the session handler.
    this._onError?.(err);
  }

  // -------------------------------------------------------------------------
  // Channel subscription handler
  // -------------------------------------------------------------------------

  private _handleChannelMessage(msg: Ably.InboundMessage): void {
    try {
      if (msg.name === EVENT_CANCEL) {
        // Fire-and-forget async handler — errors are caught internally.
        this._handleCancelMessage(msg).catch((error: unknown) => {
          const errInfo = new Ably.ErrorInfo(
            `unable to route cancel message; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.CancelListenerError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          this._logger?.error('DefaultAgentSession._handleChannelMessage(); cancel routing error');
          this._onError?.(errInfo);
        });
        return;
      }

      // Dispatch client-published input events to any pending
      // lookup keyed by invocation-id. Every client-originated event in
      // an invocation (user-message AND amend events such as tool-approval
      // responses and client tool outputs) carries `event-id`; the
      // lookup waits for every promised id to arrive before letting the
      // run start LLM work. Server-side lifecycle messages (run-start,
      // run-end, cancel, error) never stamp `event-id`, so
      // they're naturally excluded.
      const headers = getTransportHeaders(msg);
      const invocationId = headers[HEADER_INVOCATION_ID];
      if (invocationId && headers[HEADER_EVENT_ID] !== undefined) {
        const listener = this._pendingInputEventLookups.get(invocationId);
        if (listener) {
          listener(msg);
        } else {
          // Over-arrival: lookup for this invocation already completed
          // successfully (e.g. client published more input
          // events than the invocation's `inputEventIds` listed). Warn
          // loudly so client-side bugs surface, then drop the message —
          // no listener will ever register for this completed lookup,
          // so buffering would just hold a slot until FIFO eviction.
          // The run is not cancelled.
          const completedExpectedCount = this._completedLookupInvocationIds.get(invocationId);
          if (completedExpectedCount !== undefined) {
            this._logger?.warn(
              'DefaultAgentSession._handleChannelMessage(); over-arrival input event after lookup completed',
              {
                invocationId,
                expectedCount: completedExpectedCount,
                codecMessageId: headers[HEADER_CODEC_MESSAGE_ID],
              },
            );
            return;
          }
          // Buffer for a future `_registerInputEventListener` call. This is
          // load-bearing for the "agent attaches after publish" scenario
          // where channel rewind delivers user messages before
          // `run.start()` runs.
          const existing = this._inputEventBuffer.get(invocationId);
          if (existing) {
            existing.push(msg);
          } else {
            if (this._inputEventBuffer.size >= this._inputEventBufferLimit) {
              // FIFO eviction: drop the oldest invocation entry (and all
              // its buffered messages). Clients whose input event was evicted
              // will fail their lookup with `InputEventNotFound` — this warn
              // is the only operator-visible signal that capacity caused
              // the failure.
              const oldestKey = this._inputEventBuffer.keys().next().value;
              if (oldestKey !== undefined) {
                this._inputEventBuffer.delete(oldestKey);
                this._logger?.warn(
                  'DefaultAgentSession._handleChannelMessage(); input-event buffer full, dropping oldest entry',
                  {
                    evictedInvocationId: oldestKey,
                    limit: this._inputEventBufferLimit,
                  },
                );
              }
            }
            this._inputEventBuffer.set(invocationId, [msg]);
          }
        }
      }
    } catch (error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to process channel message; ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.SessionSubscriptionError,
        500,
        error instanceof Ably.ErrorInfo ? error : undefined,
      );
      this._logger?.error('DefaultAgentSession._handleChannelMessage(); subscription error');
      this._onError?.(errInfo);
    }
  }

  // -------------------------------------------------------------------------
  // Connection guard
  // -------------------------------------------------------------------------

  private async _requireConnected(method: string): Promise<void> {
    if (!this._connectPromise) {
      throw new Ably.ErrorInfo(
        `unable to ${method}; connect() must be called before ${method}()`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    return this._connectPromise;
  }

  // -------------------------------------------------------------------------
  // Run creation
  // -------------------------------------------------------------------------

  private _createRun(
    invocation: Invocation,
    runtime: RunRuntime<TOutput>,
  ): Run<TInput, TOutput, TProjection, TMessage> {
    const runId = invocation.runId;
    const invocationId = invocation.invocationId;
    const inputEventLookupTimeoutMs = this._inputEventLookupTimeoutMs;
    const { onMessage, onCancelled, onCancel, onError: runOnError, signal: externalSignal } = runtime;

    const controller = new AbortController();
    let state = RunState.INITIALIZED;

    // Compose the internal controller signal with the external signal (e.g.
    // req.signal) so platform-level cancellation (request cancellation, function
    // timeout) cancels the run through the same path as Ably cancel messages.
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;

    // Spec: AIT-ST3a — register immediately so early cancels can fire the AbortSignal.
    const registration: RegisteredRun = {
      runId,
      invocationId,
      controller,
      signal,
      onCancel,
      onError: runOnError,
    };
    this._registeredRuns.set(runId, registration);

    // Capture instance members as locals so arrow functions close over them
    // without needing `this` (avoids unicorn/no-this-assignment).
    const logger = this._logger;
    const runManager = this._runManager;
    const codec = this._codec;
    const channel = this._channel;
    const registeredRuns = this._registeredRuns;
    const requireConnected = this._requireConnected.bind(this);
    const registerInputEventListener = this._registerInputEventListener.bind(this);
    const recordCompletedLookup = this._recordCompletedLookup.bind(this);
    const inputEventId = invocation.inputEventId;

    // `viewMessages` starts empty. `Run.start()` populates it via the
    // channel-rewind input-event lookup, pulling in user-message MessageNodes
    // as they arrive on the channel.
    const viewMessages: MessageNode<TMessage>[] = [];
    const view: RunView<TMessage> = {
      get messages() {
        return viewMessages;
      },
    };

    // Per-run metadata resolved from the input-event lookup result. The first
    // matched wire message's headers carry the run's `clientId`, `parent`,
    // `forkOf`, and continuation flag; its Ably-level publisher `clientId`
    // becomes the `inputClientId` re-stamped on the agent's own publishes.
    // Captured separately from `viewMessages` because tool-resolution wire
    // messages (`tool-output-available` etc.) decode to chunks and produce
    // zero MessageNodes — the metadata still needs to surface.
    let resolvedClientId: string | undefined;
    let resolvedInputClientId: string | undefined;
    let resolvedParent: string | undefined;
    let resolvedForkOf: string | undefined;
    let resolvedRegenerates: string | undefined;
    let resolvedContinuation = false;
    let firstLookupHeaders: Record<string, string> | undefined;
    /**
     * Raw Ably messages observed live by the input-event lookup. Passed to
     * `loadRunProjection` so the just-published client wires don't need
     * to wait on Ably's channel history indexing window. Empty when no
     * lookup ran or no messages matched.
     */
    let liveLookupMessages: readonly Ably.InboundMessage[] | undefined;

    // Most recently loaded projection for this run only. `Run.loadProjection()`
    // and `Run.loadConversation()` both cache it so `Run.pipe()` can consult
    // `codec.resolveToolTarget` for cross-message attribution (e.g. approved-tool
    // second-pass tool outputs redirect to the original assistant). `undefined`
    // before any load call; pipe falls back to natural messageId behaviour then.
    let cachedProjection: TProjection | undefined;

    // Full multi-turn conversation, set by `Run.loadConversation()`. When set,
    // it takes priority over `cachedProjection` in the `messages` getter —
    // the getter then returns the complete ancestor-chain + current-run
    // messages instead of the current run alone.
    let cachedConversation: TMessage[] | undefined;

    const run: Run<TInput, TOutput, TProjection, TMessage> = {
      get runId() {
        return runId;
      },
      get abortSignal() {
        return signal;
      },
      get view() {
        return view;
      },
      get messages() {
        if (cachedConversation !== undefined) {
          return [...cachedConversation];
        }
        if (cachedProjection !== undefined) {
          return codec.getMessages(cachedProjection);
        }
        return viewMessages.map((n) => n.message);
      },

      // Spec: AIT-ST4, AIT-ST4a, AIT-ST4b
      start: async (): Promise<void> => {
        logger?.trace('Run.start();', { runId, inputEventId });

        await requireConnected('start');

        // Spec: AIT-ST4a
        if (signal.aborted) {
          throw new Ably.ErrorInfo(
            `unable to start run; run ${runId} was cancelled before start()`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (state !== RunState.INITIALIZED) return;
        state = RunState.STARTED;

        // Look up the triggering input event on the channel so the agent
        // can read the user's message and per-run metadata (parent, forkOf,
        // continuation flag) before publishing run-start. Skip when
        // inputEventLookupTimeoutMs === 0 (tests and in-process drivers) or
        // when no inputEventId is set (invocation requires no channel lookup).
        if (inputEventId && inputEventLookupTimeoutMs > 0) {
          try {
            const found = await lookupInputEvents<TInput, TOutput, TProjection, TMessage>({
              register: (callback) => registerInputEventListener(invocationId, callback),
              codec,
              invocationId,
              runId,
              expectedInputEventIds: [inputEventId],
              timeoutMs: inputEventLookupTimeoutMs,
              signal,
              logger,
            });
            recordCompletedLookup(invocationId, 1);
            for (const m of found.nodes) viewMessages.push(m);
            if (found.firstHeaders !== undefined) firstLookupHeaders = found.firstHeaders;
            if (found.firstClientId !== undefined) resolvedInputClientId = found.firstClientId;
            liveLookupMessages = found.rawMessages;
          } catch (error) {
            const errInfo =
              error instanceof Ably.ErrorInfo
                ? error
                : new Ably.ErrorInfo(
                    `unable to look up input event; ${error instanceof Error ? error.message : String(error)}`,
                    ErrorCode.InputEventNotFound,
                    504,
                  );
            // The rejection bubbles up to the developer's HTTP handler,
            // which surfaces the failure as a non-2xx response — that is
            // the signal the client sees. No channel publish: an
            // `ai-run-end` without a preceding `ai-run-start` would break
            // the lifecycle invariant for other channel observers.
            registeredRuns.delete(runId);
            logger?.error('Run.start(); input-event lookup failed', { runId, invocationId });
            throw errInfo;
          }
        }

        // Resolve per-run metadata from the first matched wire message's
        // headers — they carry `clientId`, `parent`, `forkOf`, and the
        // continuation flag. Continuations of a suspended run pick up the
        // suspended assistant's parent in the same headers (the continuation
        // wire message parents off the assistant). Fall back to the first
        // MessageNode's headers for the legacy pre-populated path where the
        // lookup ran with `viewMessages` already populated and no
        // `firstHeaders` was captured.
        const sourceHeaders = firstLookupHeaders ?? viewMessages[0]?.headers;
        if (sourceHeaders) {
          resolvedClientId = sourceHeaders[HEADER_RUN_CLIENT_ID];
          resolvedParent = sourceHeaders[HEADER_PARENT];
          resolvedForkOf = sourceHeaders[HEADER_FORK_OF];
          resolvedRegenerates = sourceHeaders[HEADER_MSG_REGENERATE];
          resolvedContinuation = sourceHeaders[HEADER_RUN_CONTINUE] === 'true';
        }

        try {
          await runManager.startRun(runId, resolvedClientId, controller, {
            parent: resolvedParent,
            forkOf: resolvedForkOf,
            regenerates: resolvedRegenerates,
            invocationId,
            inputClientId: resolvedInputClientId,
            continuation: resolvedContinuation,
          });
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish run-start for run ${runId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.RunLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Run.start(); failed to publish run-start', { runId });
          throw errInfo;
        }

        logger?.debug('Run.start(); run started', { runId, inputEventId });
      },

      // Spec: AIT-ST5, AIT-ST5a, AIT-ST5b, AIT-ST5c
      addMessages: async (nodes: MessageNode<TMessage>[], opts?: AddMessageOptions): Promise<AddMessagesResult> => {
        logger?.trace('Run.addMessages();', { runId, count: nodes.length });

        await requireConnected('addMessages');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to add messages; start() must be called before addMessages() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }

        const codecMessageIds: string[] = [];

        try {
          for (const node of nodes) {
            // Build transport headers from the node's typed fields, then merge
            // any extra headers from the node (e.g. domain-specific headers).
            const headers = mergeHeaders(
              buildTransportHeaders({
                role: 'user',
                runId,
                codecMessageId: node.codecMessageId,
                runClientId: opts?.clientId,
                parent: node.parentId,
                forkOf: node.forkOf,
                inputEventId,
                inputClientId: resolvedInputClientId,
              }),
              node.headers,
            );

            const encoder = codec.createEncoder(channel, {
              extras: { headers },
              onMessage,
            });

            // CAST: UserMessage<TMessage> is the well-known input variant
            // produced by `codec.createUserMessage`; TInput is the codec's
            // full input union, of which UserMessage<TMessage> is one
            // member. TypeScript can't see the membership through the
            // generic boundary.
            const userInput = codec.createUserMessage(node.message) as unknown as TInput;
            await encoder.publishInput(userInput, opts?.clientId ? { clientId: opts.clientId } : undefined);

            codecMessageIds.push(node.codecMessageId);
          }
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish messages for run ${runId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.RunLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Run.addMessages(); publish failed', { runId });
          throw errInfo;
        }

        logger?.debug('Run.addMessages(); messages published', { runId, count: nodes.length });
        return { codecMessageIds };
      },

      // Spec: AIT-ST5c
      addEvents: async (nodes: EventsNode<TOutput>[]): Promise<void> => {
        logger?.trace('Run.addEvents();', { runId, count: nodes.length });

        await requireConnected('addEvents');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to add events; start() must be called before addEvents() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }

        const runOwnerClientId = runManager.getClientId(runId);

        try {
          for (const node of nodes) {
            const headers = buildTransportHeaders({
              role: 'assistant',
              runId,
              codecMessageId: node.codecMessageId,
              runClientId: runOwnerClientId,
              inputClientId: resolvedInputClientId,
            });

            const encoder = codec.createEncoder(channel, {
              extras: { headers },
              onMessage,
            });

            for (const event of node.events) {
              await encoder.publishOutput(event);
            }

            await encoder.close();
          }
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish events for run ${runId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.RunLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Run.addEvents(); publish failed', { runId });
          throw errInfo;
        }

        logger?.debug('Run.addEvents(); events published', { runId, count: nodes.length });
      },

      loadProjection: async (): Promise<TProjection> => {
        logger?.trace('Run.loadProjection();', { runId });
        await requireConnected('loadProjection');
        const projection = await loadRunProjection<TInput, TOutput, TProjection, TMessage>({
          channel,
          codec,
          runId,
          signal,
          logger,
          liveMessages: liveLookupMessages,
        });
        cachedProjection = projection;
        return projection;
      },

      loadConversation: async (options?: LoadConversationOptions): Promise<TMessage[]> => {
        logger?.trace('Run.loadConversation();', { runId });
        await requireConnected('loadConversation');
        if (signal.aborted) {
          throw new Ably.ErrorInfo(
            `unable to load conversation; run ${runId} was cancelled`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        const pageLimit = options?.pageLimit ?? 200;
        const maxMessages = options?.maxMessages ?? 2000;

        // Single channel.history() fetch for all runs. Live lookup messages are
        // merged in so the current run's just-published client wires don't depend
        // on Ably's history-indexing window. Deduped by serial (history wins),
        // sorted chronologically.
        const collected: Ably.InboundMessage[] = [];
        let page = await channel.history({ limit: pageLimit });
        collected.push(...page.items);
        while (page.hasNext() && collected.length < maxMessages) {
          const nextPage: Ably.PaginatedResult<Ably.InboundMessage> | null = await page.next();
          if (!nextPage) break;
          collected.push(...nextPage.items);
          page = nextPage;
        }
        const sortedMessages = withLiveMessages(collected, liveLookupMessages);

        // Pass 1 — build a codec-message-id → runId index from every non-lifecycle
        // message. Used to resolve the HEADER_PARENT codec-message-id on ai-run-start
        // events into the parent runId, without any out-of-band metadata from the
        // invocation body.
        const codecMsgToRunId = new Map<string, string>();
        for (const msg of sortedMessages) {
          if (msg.name === EVENT_RUN_START || msg.name === EVENT_RUN_END) continue;
          const h = getTransportHeaders(msg);
          const msgRunId = h[HEADER_RUN_ID];
          const msgCodecId = h[HEADER_CODEC_MESSAGE_ID];
          if (msgRunId && msgCodecId) codecMsgToRunId.set(msgCodecId, msgRunId);
        }

        // Pass 2 — build runMap from ai-run-start events. Each entry records the
        // run's parentRunId (resolved from HEADER_PARENT via the index above) and
        // what it replaced (regenerates / forkOf), used to derive the truncation
        // point for each ancestor during the fold.
        const runMap = new Map<
          string,
          {
            parentRunId: string | undefined;
            regenerates: string | undefined;
            forkOf: string | undefined;
          }
        >();
        for (const msg of sortedMessages) {
          if (msg.name !== EVENT_RUN_START) continue;
          const h = getTransportHeaders(msg);
          const msgRunId = h[HEADER_RUN_ID];
          if (!msgRunId) continue;
          const parentCodecMsgId = h[HEADER_PARENT];
          runMap.set(msgRunId, {
            parentRunId: parentCodecMsgId ? codecMsgToRunId.get(parentCodecMsgId) : undefined,
            regenerates: h[HEADER_MSG_REGENERATE],
            forkOf: h[HEADER_FORK_OF],
          });
        }

        // Seed the ancestor chain from the current run's parentRunId resolved from
        // channel history. If the current run's ai-run-start hasn't been indexed yet
        // (rare Ably history lag), fall back to resolvedParent from the input-event lookup
        // (a codec-message-id) resolved through the same index.
        // A cycle guard (seen Set) prevents an infinite loop on self-referential data.
        const lagFallback = resolvedParent ? codecMsgToRunId.get(resolvedParent) : undefined;
        const seedParentRunId = runMap.get(runId)?.parentRunId ?? lagFallback;
        const chain: string[] = [];
        const seen = new Set<string>();
        let current = seedParentRunId;
        while (current !== undefined) {
          if (seen.has(current)) {
            logger?.warn('Run.loadConversation(); cycle detected in ancestor chain, breaking', {
              runId: current,
            });
            break;
          }
          seen.add(current);
          if (current !== runId) chain.unshift(current);
          current = runMap.get(current)?.parentRunId;
        }

        // Fold each run's projection from the shared sorted message list —
        // no extra channel.history() calls. For each ancestor, truncate at the
        // codec-message-id that the next run in the chain replaced (via
        // regenerates or forkOf).
        const allMessages: TMessage[] = [];
        for (const [i, ancestorRunId] of chain.entries()) {
          const childRunId = chain[i + 1];
          // For the last ancestor (no child in the chain array), truncate at the
          // codec-message-id the current run regenerated or forked. Prefer the
          // value resolved from channel history (runMap.get(runId)); fall back to
          // the input-event lookup values in case the current run's ai-run-start hasn't
          // been indexed yet.
          const truncateAt =
            childRunId === undefined
              ? (runMap.get(runId)?.regenerates ?? resolvedRegenerates ?? runMap.get(runId)?.forkOf ?? resolvedForkOf)
              : (runMap.get(childRunId)?.regenerates ?? runMap.get(childRunId)?.forkOf);
          const { projection } = foldRunMessages(codec, sortedMessages, ancestorRunId, truncateAt);
          allMessages.push(...codec.getMessages(projection));
        }

        // Current run — fold from the same sorted messages (live messages already
        // merged in by withLiveMessages above).
        const { projection: currentProjection, folded } = foldRunMessages(codec, sortedMessages, runId);
        cachedProjection = currentProjection;
        allMessages.push(...codec.getMessages(currentProjection));

        logger?.debug('Run.loadConversation(); built', {
          runId,
          ancestorCount: chain.length,
          totalMessages: allMessages.length,
          folded,
        });
        cachedConversation = allMessages;
        return allMessages;
      },

      // Spec: AIT-ST6, AIT-ST6a, AIT-ST6b, AIT-ST6b1, AIT-ST6b2, AIT-ST6b3, AIT-ST6c
      pipe: async (stream: ReadableStream<TOutput>, streamOpts?: PipeOptions<TOutput>): Promise<StreamResult> => {
        logger?.trace('Run.pipe();', { runId });

        await requireConnected('pipe');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to pipe stream; start() must be called before pipe() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }

        const runOwnerClientId = runManager.getClientId(runId);

        // Resolve the assistant message's parent. Priority (highest first):
        //   1. Explicit `streamOpts.parent` from the caller.
        //   2. The most recently looked-up input event for this run — so the
        //      assistant threads under the user msg that triggered it.
        //   3. `resolvedParent` from the input-event lookup's `firstLookupHeaders`.
        //      For regenerate wires the lookup matches the event (by
        //      inputEventId) but produces no MessageNodes, so `viewMessages` is
        //      empty — the regenerate event's `parent` header carries
        //      the parent codec-message-id we need to thread under.
        // Owning the default here means agent routes don't have to remember
        // to pass `{ parent: lastUserCodecMessageId }` to keep tree threading correct;
        // edit-then-regenerate sibling resolution relies on the user→assistant
        // chain being explicit.
        const lastViewCodecMessageId = viewMessages.at(-1)?.codecMessageId;
        const assistantParent = streamOpts?.parent ?? lastViewCodecMessageId ?? resolvedParent;
        const assistantForkOf = streamOpts?.forkOf ?? resolvedForkOf;
        // Echo `msg-regenerate` on the assistant wire so that a
        // client receiving the assistant chunk before `ai-run-start`
        // (e.g. via history pagination across a page boundary, or a lost
        // lifecycle publish) can still populate `RunNode.regeneratesCodecMessageId`
        // when creating the Run from headers. Mirrors the symmetric
        // behaviour for `assistantForkOf` on edit runs.
        const assistantRegenerates = resolvedRegenerates;

        const codecMessageId = crypto.randomUUID();
        const defaultHeaders = buildTransportHeaders({
          role: 'assistant',
          runId,
          codecMessageId,
          runClientId: runOwnerClientId,
          parent: assistantParent,
          forkOf: assistantForkOf,
          inputClientId: resolvedInputClientId,
          regenerates: assistantRegenerates,
        });
        const encoder = codec.createEncoder(channel, {
          extras: { headers: defaultHeaders },
          onMessage,
          messageId: codecMessageId,
        });

        // Compose caller-supplied resolveWriteOptions with codec-driven
        // tool-output attribution. After a `loadProjection` call, the
        // codec's `resolveToolTarget` returns the original message id for
        // tool-output chunks whose toolCallId matches an awaiting tool
        // call in the projection — letting the reducer fold them onto the
        // original message via the standard messageId routing path. The
        // caller's `messageId` (if any) wins over the codec's suggestion.
        const composed = (event: TOutput): WriteOptions | undefined => {
          const callerResolved = streamOpts?.resolveWriteOptions?.(event);
          if (cachedProjection === undefined) return callerResolved;
          const target = codec.resolveToolTarget(event, cachedProjection);
          if (target === undefined) return callerResolved;
          return {
            ...callerResolved,
            messageId: callerResolved?.messageId ?? target,
          };
        };

        const result = await pipeStream(stream, encoder, signal, onCancelled, composed, logger);

        if (result.error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to pipe response for run ${runId}; ${result.error.message}`,
            ErrorCode.StreamError,
            500,
            result.error instanceof Ably.ErrorInfo ? result.error : undefined,
          );
          logger?.error('Run.pipe(); stream error', { runId });
          runOnError?.(errInfo);
        }

        logger?.debug('Run.pipe(); stream finished', { runId, reason: result.reason });
        return result;
      },

      // Spec: AIT-ST7, AIT-ST7a, AIT-ST7b
      end: async (reason: RunEndReason): Promise<void> => {
        logger?.trace('Run.end();', { runId, reason });

        await requireConnected('end');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to end run; start() must be called before end() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (state === RunState.ENDED) return;
        state = RunState.ENDED;

        try {
          await runManager.endRun(runId, reason, invocationId, resolvedInputClientId);
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish run-end for run ${runId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.RunLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Run.end(); failed to publish run-end', { runId });
          throw errInfo;
        } finally {
          registeredRuns.delete(runId);
        }

        logger?.debug('Run.end(); run ended', { runId, reason });
      },
    };

    return run;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an agent (server-side) session bound to the given Realtime client
 * and channel name. The caller owns the client's lifecycle; the session
 * owns its channel.
 * @param options - Session configuration.
 * @returns A new {@link AgentSession} instance.
 */
export const createAgentSession = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: AgentSessionOptions<TInput, TOutput, TProjection, TMessage>,
): AgentSession<TInput, TOutput, TProjection, TMessage> => new DefaultAgentSession(options);
