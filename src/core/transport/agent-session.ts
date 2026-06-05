/**
 * Core agent (server-side) session, parameterized by codec.
 *
 * Composes RunManager and pipeStream to handle the full server-side run
 * lifecycle. Cancel message routing is handled directly by the session's
 * single channel subscription — no separate cancel manager needed.
 *
 * The session exposes a single factory method — `createRun()` — which returns
 * a Run object with explicit lifecycle methods: start(), pipe(), addEvents(),
 * and end().
 */

import * as Ably from 'ably';

import {
  EVENT_CANCEL,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { compareBySerial, getTransportHeaders } from '../../utils.js';
import { registerAgent } from '../agent.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import { buildTransportHeaders } from './headers.js';
import { Invocation } from './invocation.js';
import { loadConversation, loadRunProjection } from './load-conversation.js';
import { pipeStream } from './pipe-stream.js';
import type { RunManager } from './run-manager.js';
import { createRunManager } from './run-manager.js';
import type {
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
 * @param opts.register - Session-provided registration that delivers the input events for the expected event-ids. Returns an unregister function.
 * @param opts.codec - Codec used to decode arriving messages.
 * @param opts.invocationId - Invocation identifier — used only for diagnostic logging and error messages.
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
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
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

  const collected: MessageNode<TMessage>[] = [];
  const rawMessages: Ably.InboundMessage[] = [];
  const matchedInputEventIds = new Set<string>();
  let firstHeaders: Record<string, string> | undefined;
  let firstClientId: string | undefined;

  /**
   * Decode an inbound Ably message into MessageNodes via the codec.
   * @param m - The inbound Ably message to decode.
   * @returns The decoded MessageNodes carrying transport headers and serial.
   */
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
      collected.sort(compareBySerial);
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
  /** Invocation-id this run is associated with, minted by the agent at `createRun` (or the `runtime.invocationId` override). */
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
> implements AgentSession<TOutput, TProjection, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: AgentSessionOptions<TInput, TOutput, TProjection, TMessage>['codec'];
  private readonly _logger: Logger | undefined;
  private readonly _onError: ((error: Ably.ErrorInfo) => void) | undefined;
  private readonly _runManager: RunManager;
  private readonly _registeredRuns = new Map<string, RegisteredRun>();
  /**
   * Reverse index from a run's triggering input codec-message-id to its
   * run-id, populated once `Run.start()`'s input-event lookup resolves the
   * triggering input. Lets `_handleCancelMessage` route a cancel keyed by the
   * input codec-message-id (a fresh send whose run-id the client doesn't know)
   * to the registered run. Entries are removed when the run ends / suspends /
   * the session closes, alongside `_registeredRuns`.
   */
  private readonly _runIdByInputCodecMessageId = new Map<string, string>();
  /**
   * Cancels buffered by triggering input codec-message-id when they arrived
   * before the run was known — i.e. before `Run.start()`'s input-event lookup
   * resolved that input to a run. A fresh run has no run-id at the client's
   * send time (the agent mints it at run-start), so an early cancel can only be
   * keyed by the input codec-message-id, and the `inputCodecMessageId → run`
   * linkage doesn't exist until the lookup completes. `Run.start()` consults
   * this buffer as a PULL once it resolves its `resolvedInputCodecMessageId`,
   * honouring any cancel that arrived first. Mirrors `_inputEventBuffer`: FIFO
   * eviction at `_inputEventBufferLimit` entries, cleared on `close()`.
   */
  private readonly _deferredCancels = new Map<string, Ably.InboundMessage>();
  /**
   * Active input-event lookups keyed by `event-id`. The channel listener
   * dispatches each input event to the lookup that registered for its
   * `event-id`, so that messages replayed via channel rewind (and live
   * messages alike) reach the right lookup without each lookup having to
   * subscribe separately, and without depending on a client-minted
   * `invocation-id`.
   */
  private readonly _pendingInputEventLookups = new Map<string, (msg: Ably.InboundMessage) => void>();
  /**
   * Input events buffered by `event-id` when no lookup callback was
   * registered at delivery time. Rewind replays user messages on attach —
   * before `run.start()` runs — so without buffering they would be dropped.
   * Each `event-id` maps to an ordered array so rewind redelivery of the
   * same event before registration is preserved (the lookup later dedupes by
   * serial). `_registerInputEventListener` drains the buffer on registration.
   * FIFO eviction at `_inputEventBufferLimit` event entries (each entry counts
   * once regardless of array length).
   */
  private readonly _inputEventBuffer = new Map<string, Ably.InboundMessage[]>();
  private readonly _inputEventBufferLimit: number;
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
   * Register a callback to receive the input events carrying any of the
   * given `eventIds`. Lookups must share the session's unfiltered
   * subscription rather than registering their own subscribe — Ably's
   * rewind only delivers to listeners present at attach time.
   *
   * The listener remains registered after the initial buffer drain so a
   * matching event that arrives live (rather than from the buffer) still
   * reaches the lookup until it unregisters itself. Today the only caller
   * registers a single trigger event-id; the array form keeps the
   * registration capable of awaiting several ids without changing callers.
   * @param eventIds - The `event-id`s this listener cares about.
   * @param callback - Invoked once per matching Ably message, in buffer-insertion order for drained entries.
   * @returns Unregister function. Safe to call multiple times.
   */
  private _registerInputEventListener(
    eventIds: readonly string[],
    callback: (msg: Ably.InboundMessage) => void,
  ): () => void {
    for (const eventId of eventIds) {
      this._pendingInputEventLookups.set(eventId, callback);
    }
    // Drain any buffered input events for these event-ids — rewind replays
    // user messages on attach before run.start() can register the callback.
    // Without this drain, the lookup waits the full
    // `inputEventLookupTimeoutMs` for a live arrival that never comes. Set
    // all listeners before draining so a drain that completes the lookup
    // synchronously cannot leave a later event-id unmapped.
    for (const eventId of eventIds) {
      const buffered = this._inputEventBuffer.get(eventId);
      if (buffered) {
        this._inputEventBuffer.delete(eventId);
        for (const m of buffered) callback(m);
      }
    }
    return () => {
      for (const eventId of eventIds) {
        if (this._pendingInputEventLookups.get(eventId) === callback) {
          this._pendingInputEventLookups.delete(eventId);
        }
      }
    };
  }

  // Spec: AIT-ST3
  createRun(invocation: Invocation, runtime?: RunRuntime<TOutput>): Run<TOutput, TProjection, TMessage> {
    this._logger?.trace('DefaultAgentSession.createRun();', { inputEventId: invocation.inputEventId });
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
    this._runIdByInputCodecMessageId.clear();
    this._deferredCancels.clear();
    this._pendingInputEventLookups.clear();
    this._inputEventBuffer.clear();
    this._runManager.close();
    this._logger?.debug('DefaultAgentSession.close(); session closed');
  }

  // -------------------------------------------------------------------------
  // Cancel message routing
  // -------------------------------------------------------------------------

  private async _handleCancelMessage(msg: Ably.InboundMessage): Promise<void> {
    const headers = getTransportHeaders(msg);
    const runId = headers[HEADER_RUN_ID];
    const inputCodecMessageId = headers[HEADER_INPUT_CODEC_MESSAGE_ID];

    // Malformed cancel: drop with warn. A cancel must identify its target by
    // `run-id` (a continuation, whose run-id the client knows) and/or by
    // `input-codec-message-id` (a fresh send, before the agent minted the
    // run-id). Neither present means there is nothing to route to.
    if (!runId && !inputCodecMessageId) {
      this._logger?.warn('DefaultAgentSession._handleCancelMessage(); missing run-id and input-codec-message-id', {
        serial: msg.serial,
      });
      return;
    }

    // Primary path — match by run-id (continuations, whose run-id the client
    // already knows). Resolve the input-codec-message-id to a run-id when the
    // run-id wasn't supplied (a fresh-send cancel that arrived after the run's
    // input-event lookup resolved, so the linkage already exists).
    const resolvedRunId =
      runId ?? (inputCodecMessageId ? this._runIdByInputCodecMessageId.get(inputCodecMessageId) : undefined);
    const reg = resolvedRunId ? this._registeredRuns.get(resolvedRunId) : undefined;

    if (!reg) {
      // The run isn't known yet. A fresh-send cancel can race ahead of the
      // run's input-event lookup (which is what establishes the
      // input-codec-message-id → run linkage). Buffer it by
      // input-codec-message-id so `Run.start()` can pull and honour it once it
      // resolves the triggering input. A bare run-id cancel for an unknown run
      // is a no-op (the run never existed here, or already ended).
      if (inputCodecMessageId !== undefined) {
        this._bufferDeferredCancel(inputCodecMessageId, msg);
      }
      return;
    }

    await this._cancelRegistration(reg, msg);
  }

  /**
   * Buffer a cancel that arrived before its target run was known, keyed by the
   * triggering input's codec-message-id. FIFO-evicts the oldest entry at
   * `_inputEventBufferLimit` (mirroring `_inputEventBuffer`). A later cancel
   * for the same input replaces the earlier one — the intent is identical.
   * @param inputCodecMessageId - The triggering input's codec-message-id.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  private _bufferDeferredCancel(inputCodecMessageId: string, msg: Ably.InboundMessage): void {
    if (!this._deferredCancels.has(inputCodecMessageId) && this._deferredCancels.size >= this._inputEventBufferLimit) {
      const oldestKey = this._deferredCancels.keys().next().value;
      if (oldestKey !== undefined) {
        this._deferredCancels.delete(oldestKey);
        this._logger?.warn(
          'DefaultAgentSession._bufferDeferredCancel(); deferred-cancel buffer full, dropping oldest',
          {
            evictedInputCodecMessageId: oldestKey,
            limit: this._inputEventBufferLimit,
          },
        );
      }
    }
    this._deferredCancels.set(inputCodecMessageId, msg);
    this._logger?.debug('DefaultAgentSession._bufferDeferredCancel(); buffered early cancel', {
      inputCodecMessageId,
      serial: msg.serial,
    });
  }

  /**
   * Pull and honour a cancel buffered before this run was known. Called from
   * `Run.start()` once the input-event lookup resolves the run's triggering
   * input codec-message-id — the point at which the
   * `input-codec-message-id → run` linkage first exists. No-op when no cancel
   * was buffered for that input.
   * @param reg - The now-known run registration.
   * @param inputCodecMessageId - The run's resolved triggering input codec-message-id.
   */
  private async _pullDeferredCancel(reg: RegisteredRun, inputCodecMessageId: string): Promise<void> {
    const buffered = this._deferredCancels.get(inputCodecMessageId);
    if (buffered === undefined) return;
    this._deferredCancels.delete(inputCodecMessageId);
    this._logger?.debug('DefaultAgentSession._pullDeferredCancel(); honouring buffered cancel', {
      runId: reg.runId,
      inputCodecMessageId,
    });
    await this._cancelRegistration(reg, buffered);
  }

  /**
   * Fire a cancel against a known run: consult its `onCancel` authorization
   * hook (if any), then abort the run's controller. Shared by the run-id match,
   * the input-codec-message-id match, and the buffered-cancel pull so all three
   * honour `onCancel` and surface handler errors identically.
   * @param reg - The target run registration.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  private async _cancelRegistration(reg: RegisteredRun, msg: Ably.InboundMessage): Promise<void> {
    const { runId } = reg;
    this._logger?.debug('DefaultAgentSession._cancelRegistration(); matched run', { runId });

    const request: CancelRequest = { message: msg, runId };

    try {
      if (reg.onCancel) {
        const allowed = await reg.onCancel(request);
        if (!allowed) {
          this._logger?.debug('DefaultAgentSession._cancelRegistration(); cancel rejected by onCancel', {
            runId,
          });
          return;
        }
      }
      reg.controller.abort();
      this._logger?.debug('DefaultAgentSession._cancelRegistration(); run cancelled', { runId });
    } catch (error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to process cancel for run ${runId}; onCancel handler threw: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.CancelListenerError,
        500,
        error instanceof Ably.ErrorInfo ? error : undefined,
      );
      this._logger?.error('DefaultAgentSession._cancelRegistration(); onCancel threw', { runId });
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

      // Dispatch client-published input events to the lookup registered
      // for their `event-id`. Every client-originated event in an
      // invocation (user-message AND amend events such as tool-approval
      // responses and client tool outputs) carries `event-id`; the lookup
      // waits for every promised id to arrive before letting the run start
      // LLM work. Routing by `event-id` rather than `invocation-id` keeps
      // the dispatcher independent of any client-minted invocation
      // identity. Server-side lifecycle messages (run-start, run-end,
      // cancel, error) never stamp `event-id`, so they're naturally
      // excluded.
      const headers = getTransportHeaders(msg);
      const eventId = headers[HEADER_EVENT_ID];
      if (eventId !== undefined) {
        const listener = this._pendingInputEventLookups.get(eventId);
        if (listener) {
          listener(msg);
        } else {
          // Buffer for a future `_registerInputEventListener` call. This is
          // load-bearing for the "agent attaches after publish" scenario
          // where channel rewind delivers user messages before
          // `run.start()` runs.
          const existing = this._inputEventBuffer.get(eventId);
          if (existing) {
            existing.push(msg);
          } else {
            if (this._inputEventBuffer.size >= this._inputEventBufferLimit) {
              // FIFO eviction: drop the oldest event entry (and all its
              // buffered redeliveries). Clients whose input event was evicted
              // will fail their lookup with `InputEventNotFound` — this warn
              // is the only operator-visible signal that capacity caused
              // the failure.
              const oldestKey = this._inputEventBuffer.keys().next().value;
              if (oldestKey !== undefined) {
                this._inputEventBuffer.delete(oldestKey);
                this._logger?.warn(
                  'DefaultAgentSession._handleChannelMessage(); input-event buffer full, dropping oldest entry',
                  {
                    evictedEventId: oldestKey,
                    limit: this._inputEventBufferLimit,
                  },
                );
              }
            }
            this._inputEventBuffer.set(eventId, [msg]);
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

  private _createRun(invocation: Invocation, runtime: RunRuntime<TOutput>): Run<TOutput, TProjection, TMessage> {
    // The run-id is no longer carried in the invocation body. Mint a
    // provisional id now (or take the `runtime.runId` override for tests /
    // in-process drivers) — this IS the id for a fresh run. A continuation
    // overrides it in `Run.start()` with the existing run-id read off the
    // triggering input event's wire headers (the run it re-enters). Mirrors
    // the invocationId mint below.
    let runId = runtime.runId ?? crypto.randomUUID();
    // The agent mints the invocation id — one per HTTP request that invokes
    // it. A per-run override (runtime.invocationId) supports deterministic ids
    // in tests and in-process drivers.
    const invocationId = runtime.invocationId ?? crypto.randomUUID();
    const inputEventLookupTimeoutMs = this._inputEventLookupTimeoutMs;
    const { onMessage, onCancelled, onCancel, onError: runOnError, signal: externalSignal } = runtime;

    const controller = new AbortController();
    let state = RunState.INITIALIZED;

    // Compose the internal controller signal with the external signal (e.g.
    // req.signal) so platform-level cancellation (request cancellation, function
    // timeout) cancels the run through the same path as Ably cancel messages.
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;

    // Spec: AIT-ST3a — register immediately so `close()` aborts an in-flight
    // start() and a post-lookup cancel can fire the AbortSignal. Keyed by the
    // provisional run-id; a continuation re-keys to the real id in start()
    // once the triggering input reveals it.
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
    const runIdByInputCodecMessageId = this._runIdByInputCodecMessageId;
    const deferredCancels = this._deferredCancels;
    const requireConnected = this._requireConnected.bind(this);
    const registerInputEventListener = this._registerInputEventListener.bind(this);
    const pullDeferredCancel = this._pullDeferredCancel.bind(this);
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
    // matched wire message's headers carry the run's `clientId`, `parent`, and
    // `forkOf`, and — for a continuation — the `run-id` it re-enters (a fresh
    // input carries none; the client stamps a run-id only when re-entering a
    // run it already knows). Its Ably-level publisher `clientId` becomes the
    // `inputClientId` re-stamped on the agent's own publishes. Captured
    // separately from `viewMessages` because tool-resolution wire messages
    // (`tool-output-available` etc.) decode to chunks and produce zero
    // MessageNodes — the metadata still needs to surface.
    let resolvedClientId: string | undefined;
    let resolvedInputClientId: string | undefined;
    let resolvedParent: string | undefined;
    let resolvedForkOf: string | undefined;
    let resolvedRegenerates: string | undefined;
    let resolvedInputCodecMessageId: string | undefined;
    let resolvedContinuation = false;
    let firstLookupHeaders: Record<string, string> | undefined;
    /**
     * The reply run's structural-parent fallback, computed once in
     * `Run.start()` (after the input-event lookup has populated `viewMessages`)
     * and consumed by every `Run.pipe()` publish. A per-stream
     * `streamOpts.parent` still overrides it. Storing it here keeps it stable
     * across pipes and decouples the assistant's structural parent from the
     * run-start wire's own `parent`.
     */
    let assistantParentFallback: string | undefined;
    /**
     * Raw Ably messages observed live by the input-event lookup. Passed to
     * `loadRunProjection` so the just-published client wires don't need
     * to wait on Ably's channel history indexing window. Empty when no
     * lookup ran or no messages matched.
     */
    let liveLookupMessages: readonly Ably.InboundMessage[] | undefined;

    /**
     * Remove this run from the session's routing maps. Drops the
     * `_registeredRuns` entry plus the `input-codec-message-id → run-id`
     * reverse index (and any stale deferred cancel still buffered for that
     * input), keeping the cancel-routing state consistent when the run ends,
     * suspends, or its start fails.
     */
    const deregisterRun = (): void => {
      registeredRuns.delete(runId);
      if (resolvedInputCodecMessageId !== undefined) {
        runIdByInputCodecMessageId.delete(resolvedInputCodecMessageId);
        deferredCancels.delete(resolvedInputCodecMessageId);
      }
    };

    // Most recently loaded projection for this run only, cached by
    // `Run.loadProjection()` and `Run.loadConversation()` so the `messages`
    // getter can return the run's folded messages. `undefined` before any
    // load call; the getter then falls back to the live `viewMessages`.
    let cachedProjection: TProjection | undefined;

    // Full multi-turn conversation, set by `Run.loadConversation()`. When set,
    // it takes priority over `cachedProjection` in the `messages` getter —
    // the getter then returns the complete ancestor-chain + current-run
    // messages instead of the current run alone.
    let cachedConversation: TMessage[] | undefined;

    const run: Run<TOutput, TProjection, TMessage> = {
      get runId() {
        return runId;
      },
      get invocationId() {
        return invocationId;
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
              register: (callback) => registerInputEventListener([inputEventId], callback),
              codec,
              invocationId,
              runId,
              expectedInputEventIds: [inputEventId],
              timeoutMs: inputEventLookupTimeoutMs,
              signal,
              logger,
            });
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
            deregisterRun();
            logger?.error('Run.start(); input-event lookup failed', { runId, invocationId });
            throw errInfo;
          }
        }

        // Resolve per-run metadata from the first matched wire message's
        // headers — they carry `clientId`, `parent`, and `forkOf`.
        // Continuations of a suspended run pick up the suspended assistant's
        // parent in the same headers (the continuation wire message parents off
        // the assistant). A `run-id` on the triggering input marks a
        // continuation (re-entry via `ai-run-resume`); a fresh input carries
        // none and opens the run with `ai-run-start`. Fall back to the first
        // MessageNode's headers for the legacy pre-populated path where the
        // lookup ran with `viewMessages` already populated and no
        // `firstHeaders` was captured.
        const sourceHeaders = firstLookupHeaders ?? viewMessages[0]?.headers;
        if (sourceHeaders) {
          resolvedClientId = sourceHeaders[HEADER_RUN_CLIENT_ID];
          resolvedParent = sourceHeaders[HEADER_PARENT];
          resolvedForkOf = sourceHeaders[HEADER_FORK_OF];
          resolvedRegenerates = sourceHeaders[HEADER_MSG_REGENERATE];
          resolvedInputCodecMessageId = sourceHeaders[HEADER_CODEC_MESSAGE_ID];

          // The triggering input's run-id (if any) IS this run's identity.
          // Present → a continuation re-entering that run: adopt the id,
          // overriding the provisional one minted at construction, and re-key
          // the registration so cancel routing / deregistration resolve to the
          // real run. Absent → a fresh run: the provisional id stands and the
          // run opens with run-start.
          const wireRunId = sourceHeaders[HEADER_RUN_ID];
          resolvedContinuation = wireRunId !== undefined;
          if (wireRunId !== undefined && wireRunId !== runId) {
            registeredRuns.delete(runId);
            runId = wireRunId;
            registration.runId = runId;
            registeredRuns.set(runId, registration);
          }
        }

        // Compute the reply run's structural-parent fallback now that the
        // lookup has populated `viewMessages`: the triggering user message,
        // or — for regenerate wires that match by inputEventId but produce no
        // MessageNodes — the input wire's own `parent`. `Run.pipe()` consumes
        // this for every assistant publish.
        assistantParentFallback = viewMessages.at(-1)?.codecMessageId ?? resolvedParent;

        // The triggering input's codec-message-id is now resolved, so the
        // `input-codec-message-id → run` linkage exists: index it for live
        // cancels and pull any cancel that arrived before the run was known
        // (a fresh-send cancel published before the agent minted this run-id).
        // Honouring it here may abort the controller before run-start; that is
        // fine — the abort propagates through the same signal a normal cancel
        // would use.
        if (resolvedInputCodecMessageId !== undefined) {
          runIdByInputCodecMessageId.set(resolvedInputCodecMessageId, runId);
          await pullDeferredCancel(registration, resolvedInputCodecMessageId);
        }

        try {
          await runManager.startRun(runId, resolvedClientId, controller, {
            // Stamp the reply run's STRUCTURAL parent (its input node, M_user) —
            // the same value the output path stamps — not the input wire's own
            // parent. Makes `parent` structural on every wire so the Tree's two
            // creation paths agree regardless of arrival order. Valid only now
            // that M_user is a separate input node (the two-node flip).
            parent: assistantParentFallback,
            forkOf: resolvedForkOf,
            regenerates: resolvedRegenerates,
            invocationId,
            inputClientId: resolvedInputClientId,
            inputCodecMessageId: resolvedInputCodecMessageId,
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
              invocationId,
              inputClientId: resolvedInputClientId,
              inputCodecMessageId: resolvedInputCodecMessageId,
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
        const { messages, projection } = await loadConversation<TInput, TOutput, TProjection, TMessage>({
          channel,
          codec,
          runId,
          signal,
          logger,
          liveMessages: liveLookupMessages,
          assistantParentFallback,
          pageLimit: options?.pageLimit ?? 200,
          maxMessages: options?.maxMessages ?? 2000,
        });
        cachedProjection = projection;
        cachedConversation = messages;
        return messages;
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

        // The assistant message's parent: an explicit per-stream
        // `streamOpts.parent` from the caller, else the reply run's
        // structural-parent fallback computed once at run-start
        // (`assistantParentFallback` — the triggering user message, or the
        // input wire's own parent for regenerate wires that produced no
        // MessageNodes). Owning the default here means agent routes don't have
        // to pass `{ parent: lastUserCodecMessageId }` to keep tree threading
        // correct; edit-then-regenerate sibling resolution relies on the
        // user→assistant chain being explicit.
        const assistantParent = streamOpts?.parent ?? assistantParentFallback;
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
          invocationId,
          inputClientId: resolvedInputClientId,
          inputCodecMessageId: resolvedInputCodecMessageId,
          regenerates: assistantRegenerates,
        });
        const encoder = codec.createEncoder(channel, {
          extras: { headers: defaultHeaders },
          onMessage,
          messageId: codecMessageId,
        });

        const result = await pipeStream(stream, encoder, signal, onCancelled, streamOpts?.resolveWriteOptions, logger);

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

      suspend: async (): Promise<void> => {
        logger?.trace('Run.suspend();', { runId });

        await requireConnected('suspend');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to suspend run; start() must be called before suspend() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        // ENDED is the terminal state for either an end or a suspend on this
        // Run instance; a second terminal call is a no-op.
        if (state === RunState.ENDED) return;
        state = RunState.ENDED;

        try {
          await runManager.suspendRun(runId, invocationId, resolvedInputClientId, resolvedInputCodecMessageId);
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish run-suspend for run ${runId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.RunLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Run.suspend(); failed to publish run-suspend', { runId });
          throw errInfo;
        } finally {
          deregisterRun();
        }

        logger?.debug('Run.suspend(); run suspended', { runId });
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
          await runManager.endRun(runId, reason, invocationId, resolvedInputClientId, resolvedInputCodecMessageId);
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
          deregisterRun();
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
): AgentSession<TOutput, TProjection, TMessage> => new DefaultAgentSession(options);
