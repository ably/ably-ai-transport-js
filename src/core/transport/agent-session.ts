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
  EVENT_ERROR,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_INVOCATION_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_RUN_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_ID,
  HEADER_ROLE,
  HEADER_RUN_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { getHeaders, mergeHeaders } from '../../utils.js';
import { registerAgent } from '../agent.js';
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
  CancelFilter,
  CancelRequest,
  EventsNode,
  MessageNode,
  PipeOptions,
  Run,
  RunEndReason,
  RunRuntime,
  RunView,
  StreamResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Prompt lookup
// ---------------------------------------------------------------------------

/**
 * Wait for `expectedCount` user-prompt messages matching `invocationId` to
 * land on the channel. Uses the session's unfiltered channel dispatcher
 * (registered in `connect()`) so that messages replayed via channel rewind
 * on attach reach the lookup — no separate history fetch needed.
 *
 * Multi-message `send()` publishes each user message as a separate Ably
 * message under the same invocation-id; the lookup collects all of them
 * before resolving. Duplicates (rewind redelivering a message also seen
 * live) are deduped by Ably `serial`. Collected nodes are returned sorted
 * by `serial` ascending.
 *
 * Bounded by `timeoutMs` as a total budget across all N arrivals. The
 * caller's `signal` aborts the wait. On partial collection at timeout the
 * promise rejects with `PromptNotFound` and an error message including
 * "received X of Y". If any decode throws mid-collection, the whole lookup
 * rejects with `PromptNotFound` wrapping the decode error as cause —
 * already-collected messages are discarded.
 * @param opts - Lookup parameters.
 * @param opts.register - Session-provided registration that delivers user-prompt messages for this invocationId. Returns an unregister function.
 * @param opts.codec - Codec used to decode the matching message into MessageNodes.
 * @param opts.invocationId - Invocation identifier the dispatcher keys on.
 * @param opts.runId - Run identifier (used for logging and error messages).
 * @param opts.expectedCount - Number of distinct user-prompt Ably messages to collect before resolving.
 * @param opts.timeoutMs - Maximum total time to wait for all `expectedCount` arrivals.
 * @param opts.signal - AbortSignal that cancels the wait when the run aborts.
 * @param opts.logger - Optional logger for diagnostic output.
 * @returns The decoded MessageNodes for the matching user prompt, sorted by Ably serial.
 */
const lookupUserPrompt = async <TEvent, TProjection, TMessage>(opts: {
  register: (callback: (msg: Ably.InboundMessage) => void) => () => void;
  codec: import('../codec/types.js').Codec<TEvent, TProjection, TMessage>;
  invocationId: string;
  runId: string;
  expectedCount: number;
  timeoutMs: number;
  signal: AbortSignal;
  logger: Logger | undefined;
}): Promise<MessageNode<TMessage>[]> => {
  const { register, codec, invocationId, runId, expectedCount, timeoutMs, signal, logger } = opts;

  /**
   * Decode an inbound Ably message into MessageNodes via the codec.
   * @param m - The inbound Ably message to decode.
   * @returns The decoded MessageNodes carrying transport headers and serial.
   */
  const decode = (m: Ably.InboundMessage): MessageNode<TMessage>[] => {
    const decoder = codec.createDecoder();
    const headers = getHeaders(m);
    const msgId = headers[HEADER_MSG_ID] ?? '';
    const events = decoder.decode(m);
    let projection = codec.init();
    for (const event of events) {
      projection = codec.fold(projection, event, { serial: m.serial ?? '', messageId: msgId });
    }
    return codec.getMessages(projection).map((message) => ({
      kind: 'message' as const,
      message,
      msgId,
      parentId: headers['x-ably-parent'],
      forkOf: headers['x-ably-fork-of'],
      headers,
      serial: m.serial,
    }));
  };

  return new Promise<MessageNode<TMessage>[]>((resolve, reject) => {
    let settled = false;
    // Dedupe across rewind-redelivery: rewind may surface a message the
    // listener also saw live. Scoped to the active lookup so it cannot
    // grow unbounded.
    const seenSerials = new Set<string>();
    const collected: MessageNode<TMessage>[] = [];
    // Forward-declared so that cleanup() and onAbort() can reference them
    // before they are assigned. cleanup may run synchronously inside
    // `register(...)` (when buffered prompts drain on registration) before
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
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Ably.ErrorInfo(`unable to look up user prompt; run ${runId} was aborted`, ErrorCode.InvalidArgument, 400),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- onAbort may have settled the promise synchronously above when the signal was already aborted.
    if (settled) return;
    unregister = register((m) => {
      if (settled) return;
      if (m.serial !== undefined && seenSerials.has(m.serial)) return;
      if (m.serial !== undefined) seenSerials.add(m.serial);
      let decoded: MessageNode<TMessage>[];
      try {
        decoded = decode(m);
      } catch (error) {
        settled = true;
        cleanup();
        const cause = error instanceof Ably.ErrorInfo ? error : undefined;
        reject(
          new Ably.ErrorInfo(
            `unable to look up user prompt; decode failed for invocation ${invocationId}: ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.PromptNotFound,
            504,
            cause,
          ),
        );
        return;
      }
      for (const node of decoded) collected.push(node);
      if (collected.length < expectedCount) return;
      settled = true;
      cleanup();
      // Sort by Ably serial ascending so callers see publish order regardless
      // of interleaved rewind+live delivery. Null serials sort last (defensive
      // — user-prompt messages should always carry a serial).
      collected.sort((a, b) => {
        if (a.serial === undefined && b.serial === undefined) return 0;
        if (a.serial === undefined) return 1;
        if (b.serial === undefined) return -1;
        if (a.serial < b.serial) return -1;
        if (a.serial > b.serial) return 1;
        return 0;
      });
      logger?.debug('lookupUserPrompt(); collected user-prompt messages', {
        runId,
        invocationId,
        count: collected.length,
      });
      resolve(collected);
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the register callback may have settled the promise synchronously during buffered-prompt drain.
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
          `unable to look up user prompt; received ${String(collected.length)} of ${String(expectedCount)} user-messages for invocation ${invocationId} within ${String(timeoutMs)}ms`,
          ErrorCode.PromptNotFound,
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
  clientId: string;
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
class DefaultAgentSession<TEvent, TProjection, TMessage> implements AgentSession<TEvent, TProjection, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: AgentSessionOptions<TEvent, TProjection, TMessage>['codec'];
  private readonly _logger: Logger | undefined;
  private readonly _onError: ((error: Ably.ErrorInfo) => void) | undefined;
  private readonly _runManager: RunManager;
  private readonly _registeredRuns = new Map<string, RegisteredRun>();
  /**
   * Active user-prompt lookups keyed by invocation-id. The channel listener
   * dispatches matching user messages to these callbacks so that messages
   * replayed via channel rewind (and live messages alike) reach the right
   * lookup without each lookup having to subscribe separately.
   */
  private readonly _pendingPromptLookups = new Map<string, (msg: Ably.InboundMessage) => void>();
  /**
   * User-prompt messages buffered by invocation-id when no lookup callback
   * was registered at delivery time. Each invocation-id maps to an ordered
   * array because a single multi-message `send()` publishes N Ably messages
   * sharing one invocation-id. Rewind replays user messages on attach —
   * before `run.start()` runs — so without buffering they would be dropped.
   * `_registerPromptListener` drains the buffer on registration. FIFO
   * eviction at `_promptBufferLimit` invocation entries (each entry counts
   * once regardless of array length).
   */
  private readonly _promptBuffer = new Map<string, Ably.InboundMessage[]>();
  private readonly _promptBufferLimit: number;
  /**
   * Bounded FIFO map of invocation-ids whose lookup has resolved
   * successfully, valued by the expected count the lookup resolved at.
   * Used to distinguish over-arrival (extra user-prompt for a lookup that
   * already completed with `userMessageCount === N`) from a genuine late /
   * never-claimed arrival, so we can warn loudly on the former (with the
   * count the client claimed) without spamming on the latter. Reject paths
   * do not populate this map — their cause is already surfaced via the
   * rejection.
   */
  private readonly _completedLookupInvocationIds = new Map<string, number>();
  private readonly _completedLookupInvocationIdsLimit = 256;
  private readonly _channelListener: (msg: Ably.InboundMessage) => void;
  private readonly _promptLookupTimeoutMs: number;

  private _state = SessionState.READY;
  private _connectPromise: Promise<void> | undefined;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  constructor(options: AgentSessionOptions<TEvent, TProjection, TMessage>) {
    // Spec: AIT-ST1a, AIT-ST1a2 — register this SDK on both the connection
    // (options.agents) and channel-attach (params.agent) paths. Idempotent
    // across sessions sharing one client.
    const registerOptions = registerAgent(options.client);
    // Attach with a rewind window (default 2m) so a freshly-constructed
    // agent session can locate a user prompt that was published before it
    // attached (closes the lookup race when a per-request agent is spun
    // up after the client has already POSTed). Tunable via
    // `AgentSessionOptions.promptRewindWindow`.
    const channelOptions: Ably.ChannelOptions = {
      params: { ...registerOptions.params, rewind: options.promptRewindWindow ?? '2m' },
    };
    this._channel = options.client.channels.get(options.channelName, channelOptions);
    this._codec = options.codec;
    this._logger = options.logger?.withContext({ component: 'AgentSession' });
    this._onError = options.onError;
    this._runManager = createRunManager(this._channel, this._logger);
    this._promptLookupTimeoutMs = options.promptLookupTimeoutMs ?? 30000;
    this._promptBufferLimit = options.promptBufferLimit ?? 200;

    this._channelListener = (msg: Ably.InboundMessage) => {
      this._handleChannelMessage(msg);
    };

    // Spec: AIT-ST12, AIT-ST12a
    // Listen for channel state changes that break message continuity. The
    // session only consumes cancel messages from the channel, so losing one
    // is survivable — but the developer needs to know so they can decide
    // whether to abort in-flight work. _hasAttachedOnce is seeded from the
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
    // replayed via channel rewind reach the dispatcher so user-prompt
    // lookups can match against them; the dispatcher then routes by name
    // (cancel vs. user-prompt). A name-filtered subscribe would silently
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
   * Register a callback to receive user-prompt messages with the given
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
  private _registerPromptListener(invocationId: string, callback: (msg: Ably.InboundMessage) => void): () => void {
    this._pendingPromptLookups.set(invocationId, callback);
    // Drain any buffered user-prompt messages for this invocation-id —
    // rewind replays user messages on attach before run.start() can
    // register the callback. Without this drain, the lookup waits the
    // full `promptLookupTimeoutMs` for a live arrival that never comes.
    const buffered = this._promptBuffer.get(invocationId);
    if (buffered) {
      this._promptBuffer.delete(invocationId);
      for (const m of buffered) callback(m);
    }
    return () => {
      if (this._pendingPromptLookups.get(invocationId) === callback) {
        this._pendingPromptLookups.delete(invocationId);
      }
    };
  }

  /**
   * Record an invocation-id whose lookup has resolved successfully so a
   * subsequent unmatched arrival for the same invocation-id can be flagged
   * as an over-arrival (client published more user-prompts than
   * `userMessageCount`). Bounded FIFO eviction at
   * `_completedLookupInvocationIdsLimit`.
   * @param invocationId - The invocation-id whose lookup just completed.
   * @param expectedCount - The `userMessageCount` the lookup resolved at — surfaced in the over-arrival warn.
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
  createRun(invocation: Invocation<TEvent, TMessage>, runtime?: RunRuntime<TEvent>): Run<TEvent, TMessage> {
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
    this._pendingPromptLookups.clear();
    this._promptBuffer.clear();
    this._completedLookupInvocationIds.clear();
    this._runManager.close();
    this._logger?.debug('DefaultAgentSession.close(); session closed');
  }

  // -------------------------------------------------------------------------
  // Cancel message routing
  // -------------------------------------------------------------------------

  private _resolveFilter(filter: CancelFilter, senderClientId?: string): string[] {
    const runIds = [...this._registeredRuns.keys()];

    if (filter.all) return runIds;
    if (filter.own && senderClientId) {
      return runIds.filter((id) => this._registeredRuns.get(id)?.clientId === senderClientId);
    }
    if (filter.clientId) {
      return runIds.filter((id) => this._registeredRuns.get(id)?.clientId === filter.clientId);
    }
    if (filter.invocationId) {
      return runIds.filter((id) => this._registeredRuns.get(id)?.invocationId === filter.invocationId);
    }
    if (filter.runId && this._registeredRuns.has(filter.runId)) {
      return [filter.runId];
    }
    return [];
  }

  // Spec: AIT-ST8, AIT-ST8a, AIT-ST8b, AIT-ST8c, AIT-ST8d, AIT-ST9, AIT-ST9a
  private async _handleCancelMessage(msg: Ably.InboundMessage): Promise<void> {
    const headers = getHeaders(msg);

    // Spec: AIT-ST8a, AIT-ST8b, AIT-ST8c, AIT-ST8d
    const filter: CancelFilter = {};
    if (headers[HEADER_CANCEL_INVOCATION_ID]) {
      filter.invocationId = headers[HEADER_CANCEL_INVOCATION_ID];
    } else if (headers[HEADER_CANCEL_RUN_ID]) {
      filter.runId = headers[HEADER_CANCEL_RUN_ID];
    } else if (headers[HEADER_CANCEL_OWN] === 'true') {
      filter.own = true;
    } else if (headers[HEADER_CANCEL_CLIENT_ID]) {
      filter.clientId = headers[HEADER_CANCEL_CLIENT_ID];
    } else if (headers[HEADER_CANCEL_ALL] === 'true') {
      filter.all = true;
    }

    const matchedRunIds = this._resolveFilter(filter, msg.clientId);
    if (matchedRunIds.length === 0) return;

    this._logger?.debug('DefaultAgentSession._handleCancelMessage(); matched runs', {
      matchedRunIds,
      filter,
    });

    const owners = new Map<string, string>();
    for (const rid of matchedRunIds) {
      const reg = this._registeredRuns.get(rid);
      owners.set(rid, reg?.clientId ?? '');
    }
    const request: CancelRequest = { message: msg, filter, matchedRunIds, runOwners: owners };

    for (const runId of matchedRunIds) {
      const reg = this._registeredRuns.get(runId);
      if (!reg) continue;

      try {
        if (reg.onCancel) {
          const allowed = await reg.onCancel(request);
          if (!allowed) {
            this._logger?.debug('DefaultAgentSession._handleCancelMessage(); cancel rejected by onCancel', {
              runId,
            });
            continue;
          }
        }
        reg.controller.abort();
        this._logger?.debug('DefaultAgentSession._handleCancelMessage(); run aborted', { runId });
      } catch (error) {
        // A throwing onCancel handler must not prevent other runs from being cancelled.
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

      // Dispatch user-prompt messages to any pending lookup keyed by
      // invocation-id. The lookup itself does the role/runId discrimination
      // (invocation-ids are unique UUIDs, so the key alone is sufficient in
      // practice; the callback re-checks defensively).
      const headers = getHeaders(msg);
      const invocationId = headers[HEADER_INVOCATION_ID];
      if (invocationId && headers[HEADER_ROLE] === 'user') {
        const listener = this._pendingPromptLookups.get(invocationId);
        if (listener) {
          listener(msg);
        } else {
          // Over-arrival: lookup for this invocation already completed
          // successfully (e.g. client published N+1 messages but
          // `userMessageCount === N`). Warn loudly so client-side bugs
          // surface, then drop the message — no listener will ever
          // register for this completed lookup, so buffering would just
          // hold a slot until FIFO eviction. The run is not aborted.
          const completedExpectedCount = this._completedLookupInvocationIds.get(invocationId);
          if (completedExpectedCount !== undefined) {
            this._logger?.warn(
              'DefaultAgentSession._handleChannelMessage(); over-arrival user-prompt after lookup completed',
              {
                invocationId,
                expectedCount: completedExpectedCount,
                msgId: headers[HEADER_MSG_ID],
              },
            );
            return;
          }
          // Buffer for a future `_registerPromptListener` call. This is
          // load-bearing for the "agent attaches after publish" scenario
          // where channel rewind delivers user messages before
          // `run.start()` runs.
          const existing = this._promptBuffer.get(invocationId);
          if (existing) {
            existing.push(msg);
          } else {
            if (this._promptBuffer.size >= this._promptBufferLimit) {
              // FIFO eviction: drop the oldest invocation entry (and all
              // its buffered messages). Clients whose prompt was evicted
              // will fail their lookup with `PromptNotFound` — this warn
              // is the only operator-visible signal that capacity caused
              // the failure.
              const oldestKey = this._promptBuffer.keys().next().value;
              if (oldestKey !== undefined) {
                this._promptBuffer.delete(oldestKey);
                this._logger?.warn(
                  'DefaultAgentSession._handleChannelMessage(); prompt buffer full, dropping oldest entry',
                  {
                    evictedInvocationId: oldestKey,
                    limit: this._promptBufferLimit,
                  },
                );
              }
            }
            this._promptBuffer.set(invocationId, [msg]);
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

  private _createRun(invocation: Invocation<TEvent, TMessage>, runtime: RunRuntime<TEvent>): Run<TEvent, TMessage> {
    const runId = invocation.runId;
    const invocationId = invocation.invocationId;
    const runClientId = invocation.clientId;
    const runParent = invocation.parent;
    const runForkOf = invocation.forkOf;
    const promptLookupTimeoutMs = this._promptLookupTimeoutMs;
    const { onMessage, onAbort, onCancel, onError: runOnError, signal: externalSignal } = runtime;

    const controller = new AbortController();
    let state = RunState.INITIALIZED;

    // Compose the internal controller signal with the external signal (e.g.
    // req.signal) so platform-level cancellation (request cancellation, function
    // timeout) aborts the run through the same path as Ably cancel messages.
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;

    // Spec: AIT-ST3a — register immediately so early cancels can fire the abort signal.
    const registration: RegisteredRun = {
      runId,
      invocationId: invocation.invocationId,
      clientId: runClientId,
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
    const registerPromptListener = this._registerPromptListener.bind(this);
    const recordCompletedLookup = this._recordCompletedLookup.bind(this);
    const invocationUserMessageCount = invocation.userMessageCount;

    // invocation.messages is empty when the client publishes user messages
    // on the channel. The agent populates this buffer in start() via a
    // channel rewind+subscribe lookup keyed by invocation-id. Tests and
    // legacy callers may pre-populate via Invocation.fromJSON; in that case
    // the lookup step is skipped. The lookup is also skipped when the
    // invocation reports `userMessageCount === 0` (e.g. a continuation
    // triggered by `sendAutomaticallyWhen` after a tool result, where no
    // new user prompt was published).
    const viewMessages: MessageNode<TMessage>[] = [...invocation.messages];
    const view: RunView<TMessage> = {
      get messages() {
        return viewMessages;
      },
    };

    const run: Run<TEvent, TMessage> = {
      get runId() {
        return runId;
      },
      get abortSignal() {
        return signal;
      },
      get view() {
        return view;
      },

      // Spec: AIT-ST4, AIT-ST4a, AIT-ST4b
      start: async (): Promise<void> => {
        logger?.trace('Run.start();', { runId, invocationId });

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

        // Look up the user prompt on the channel when the invocation
        // signals a fresh send (userMessageCount > 0) but didn't carry the
        // messages inline. Skip when:
        // - viewMessages already populated (legacy / pre-populated path)
        // - promptLookupTimeoutMs === 0 (tests and in-process drivers)
        // - userMessageCount === 0 (continuation send: no new user prompt
        //   was published, so waiting for one would hang for the full
        //   deadline before erroring out)
        if (viewMessages.length === 0 && invocationUserMessageCount > 0 && promptLookupTimeoutMs > 0) {
          try {
            const found = await lookupUserPrompt<TEvent, TProjection, TMessage>({
              register: (callback) => registerPromptListener(invocationId, callback),
              codec,
              invocationId,
              runId,
              expectedCount: invocationUserMessageCount,
              timeoutMs: promptLookupTimeoutMs,
              signal,
              logger,
            });
            recordCompletedLookup(invocationId, invocationUserMessageCount);
            for (const m of found) viewMessages.push(m);
          } catch (error) {
            const errInfo =
              error instanceof Ably.ErrorInfo
                ? error
                : new Ably.ErrorInfo(
                    `unable to look up user prompt; ${error instanceof Error ? error.message : String(error)}`,
                    ErrorCode.PromptNotFound,
                    504,
                  );
            // Best-effort publish of an error event so the client can see it.
            try {
              await channel.publish({
                name: EVENT_ERROR,
                extras: {
                  headers: {
                    [HEADER_RUN_ID]: runId,
                    [HEADER_INVOCATION_ID]: invocationId,
                  },
                },
                data: { code: errInfo.code, statusCode: errInfo.statusCode, message: errInfo.message },
              });
            } catch {
              // swallow — best-effort
            }
            logger?.error('Run.start(); prompt lookup failed', { runId, invocationId });
            throw errInfo;
          }
        }

        try {
          await runManager.startRun(runId, runClientId, controller, {
            parent: runParent,
            forkOf: runForkOf,
            invocationId,
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

        logger?.debug('Run.start(); run started', { runId, invocationId });
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

        const msgIds: string[] = [];

        try {
          for (const node of nodes) {
            // Build transport headers from the node's typed fields, then merge
            // any extra headers from the node (e.g. domain-specific headers).
            const headers = mergeHeaders(
              buildTransportHeaders({
                role: 'user',
                runId,
                msgId: node.msgId,
                runClientId: opts?.clientId,
                parent: node.parentId ?? runParent,
                forkOf: node.forkOf ?? runForkOf,
                invocationId,
              }),
              node.headers,
            );

            const encoder = codec.createEncoder(channel, {
              extras: { headers },
              onMessage,
            });

            const userEvent = codec.userMessageEvent(node.message);
            await encoder.publish(userEvent, opts?.clientId ? { clientId: opts.clientId } : undefined);

            msgIds.push(node.msgId);
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
        return { msgIds };
      },

      // Spec: AIT-ST5c
      addEvents: async (nodes: EventsNode<TEvent>[]): Promise<void> => {
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
              msgId: node.msgId,
              runClientId: runOwnerClientId,
              amend: node.msgId,
            });

            const encoder = codec.createEncoder(channel, {
              extras: { headers },
              onMessage,
            });

            for (const event of node.events) {
              await encoder.publish(event);
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

      // Spec: AIT-ST6, AIT-ST6a, AIT-ST6b, AIT-ST6b1, AIT-ST6b2, AIT-ST6b3, AIT-ST6c
      pipe: async (stream: ReadableStream<TEvent>, streamOpts?: PipeOptions<TEvent>): Promise<StreamResult> => {
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

        // Per-operation parent overrides the run-level default.
        const assistantParent = streamOpts?.parent === undefined ? runParent : streamOpts.parent;

        const msgId = crypto.randomUUID();
        const defaultHeaders = buildTransportHeaders({
          role: 'assistant',
          runId,
          msgId,
          runClientId: runOwnerClientId,
          parent: assistantParent,
          forkOf: streamOpts?.forkOf ?? runForkOf,
        });
        const encoder = codec.createEncoder(channel, {
          extras: { headers: defaultHeaders },
          onMessage,
          messageId: msgId,
        });

        const result = await pipeStream(stream, encoder, signal, onAbort, streamOpts?.resolveWriteOptions, logger);

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
          await runManager.endRun(runId, reason, invocationId);
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
export const createAgentSession = <TEvent, TProjection, TMessage>(
  options: AgentSessionOptions<TEvent, TProjection, TMessage>,
): AgentSession<TEvent, TProjection, TMessage> => new DefaultAgentSession(options);
