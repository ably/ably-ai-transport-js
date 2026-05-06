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
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_RUN_ID,
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
// Internal run record for cancel routing
// ---------------------------------------------------------------------------

interface RegisteredRun {
  runId: string;
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
class DefaultAgentSession<TEvent, TMessage> implements AgentSession<TEvent, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: AgentSessionOptions<TEvent, TMessage>['codec'];
  private readonly _logger: Logger | undefined;
  private readonly _onError: ((error: Ably.ErrorInfo) => void) | undefined;
  private readonly _runManager: RunManager;
  private readonly _registeredRuns = new Map<string, RegisteredRun>();
  private readonly _channelListener: (msg: Ably.InboundMessage) => void;

  private _state = SessionState.READY;
  private _connectPromise: Promise<void> | undefined;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  constructor(options: AgentSessionOptions<TEvent, TMessage>) {
    // Spec: AIT-ST1a — register the SDK's agent identifier on the supplied
    // Realtime client for usage tracking. Idempotent across sessions.
    registerAgent(options.client);
    this._channel = options.client.channels.get(options.channelName);
    this._codec = options.codec;
    this._logger = options.logger?.withContext({ component: 'AgentSession' });
    this._onError = options.onError;
    this._runManager = createRunManager(this._channel, this._logger);

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
    // Subscribe before attach (RTL7g) — subscribe implicitly attaches the channel.
    this._connectPromise = this._channel.subscribe(EVENT_CANCEL, this._channelListener).then(
      () => {
        this._logger?.debug('DefaultAgentSession.connect(); subscribed and attached');
      },
      (error: unknown) => {
        const errInfo = new Ably.ErrorInfo(
          `unable to subscribe to cancel messages; ${error instanceof Error ? error.message : String(error)}`,
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
      this._channel.unsubscribe(EVENT_CANCEL, this._channelListener);
    }
    this._channel.off(this._onChannelStateChange);
    for (const reg of this._registeredRuns.values()) {
      reg.controller.abort();
    }
    this._registeredRuns.clear();
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
    if (headers[HEADER_CANCEL_RUN_ID]) {
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
    const runClientId = invocation.clientId;
    const runParent = invocation.parent;
    const runForkOf = invocation.forkOf;
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

    const view: RunView<TMessage> = {
      messages: invocation.messages,
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
        logger?.trace('Run.start();', { runId });

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

        try {
          await runManager.startRun(runId, runClientId, controller, {
            parent: runParent,
            forkOf: runForkOf,
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

        logger?.debug('Run.start(); run started', { runId });
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
              }),
              node.headers,
            );

            const encoder = codec.createEncoder(channel, {
              extras: { headers },
              onMessage,
            });

            await encoder.writeMessages([node.message], opts?.clientId ? { clientId: opts.clientId } : undefined);

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
              await encoder.writeEvent(event);
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
          await runManager.endRun(runId, reason);
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
 * and channel name. The session resolves the channel via
 * `client.channels.get(channelName)` and registers the `ai-transport-js`
 * agent identifier on the client for usage tracking.
 * @param options - Session configuration.
 * @returns A new {@link AgentSession} instance.
 */
export const createAgentSession = <TEvent, TMessage>(
  options: AgentSessionOptions<TEvent, TMessage>,
): AgentSession<TEvent, TMessage> => new DefaultAgentSession(options);
