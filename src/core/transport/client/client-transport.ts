/**
 * Core client-side transport, parameterized by codec.
 *
 * Composes StreamRouter and ConversationTree to handle the full client-side
 * lifecycle. Subscribes to the Ably channel on construction. The same
 * subscription, decoder, and channel are reused across turns.
 *
 * The client never publishes user messages directly. Instead, it sends them
 * to the server via HTTP POST. The server publishes user messages and turn
 * lifecycle events (turn-start, turn-end) on behalf of the client.
 */

import * as Ably from 'ably';

import {
  EVENT_CANCEL,
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_TURN_ID,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_TURN_CLIENT_ID,
  HEADER_TURN_ID,
  HEADER_TURN_REASON,
} from '../../../constants.js';
import { ErrorCode } from '../../../errors.js';
import { EventEmitter } from '../../../event-emitter.js';
import type { Logger } from '../../../logger.js';
import { LogLevel, makeLogger } from '../../../logger.js';
import { getHeaders } from '../../../utils.js';
import type { DecoderOutput, MessageAccumulator, StreamDecoder } from '../../codec/types.js';
import { buildTransportHeaders } from '../headers.js';
import type { CancelFilter, MessageWithHeaders, TurnEndReason, TurnLifecycleEvent } from '../types.js';
import { createConversationTree } from './conversation-tree.js';
import { decodeHistory } from './decode-history.js';
import type { StreamRouter } from './stream-router.js';
import { createStreamRouter } from './stream-router.js';
import type {
  ActiveTurn,
  ClientTransport,
  ClientTransportOptions,
  CloseOptions,
  ConversationTree,
  LoadHistoryOptions,
  PaginatedMessages,
  SendOptions,
} from './types.js';

/**
 * Returned from `on()` when the transport is already closed — the subscription
 * is silently ignored since no further events will fire.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op
const noopUnsubscribe = (): void => {};

// ---------------------------------------------------------------------------
// Event map for the transport's typed EventEmitter
// ---------------------------------------------------------------------------

interface ClientTransportEventsMap {
  message: undefined;
  turn: TurnLifecycleEvent;
  error: Ably.ErrorInfo;
  'ably-message': undefined;
}

// ---------------------------------------------------------------------------
// Per-turn observer state — consolidated to avoid parallel-map bookkeeping
// ---------------------------------------------------------------------------

interface TurnObserverState<TEvent, TMessage> {
  headers: Record<string, string>;
  serial: string | undefined;
  accumulator: MessageAccumulator<TEvent, TMessage>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CT1
class DefaultClientTransport<TEvent, TMessage> implements ClientTransport<TEvent, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: ClientTransportOptions<TEvent, TMessage>['codec'];
  private readonly _clientId: string | undefined;
  private readonly _api: string;
  private readonly _credentials: RequestCredentials | undefined;
  private readonly _headersFn: (() => Record<string, string>) | undefined;
  private readonly _bodyFn: (() => Record<string, unknown>) | undefined;
  private readonly _fetchFn: typeof globalThis.fetch;
  private readonly _logger: Logger;

  // Typed event emitter for all transport events
  private readonly _emitter: EventEmitter<ClientTransportEventsMap>;

  // Relay detection — tracks msg-ids of optimistic inserts for reconciliation
  private readonly _ownMsgIds = new Set<string>();
  private readonly _ownTurnIds = new Set<string>();

  // Track clientId per turn for getActiveTurnIds()
  private readonly _turnClientIds = new Map<string, string>();
  // Track msgIds per turn for cleanup on turn-end
  private readonly _turnMsgIds = new Map<string, Set<string>>();

  // Per-turn observer state: headers, serial, and accumulator in one map.
  // A single .delete(turnId) cleans up all three.
  private readonly _turnObservers = new Map<string, TurnObserverState<TEvent, TMessage>>();

  // Raw Ably message log
  private readonly _ablyMessages: Ably.InboundMessage[] = [];

  // History pagination: withheld messages hidden from getMessages()
  private readonly _withheldKeys = new Set<string>();

  // Sub-components
  private readonly _tree: ConversationTree<TMessage>;
  private readonly _router: StreamRouter<TEvent>;
  private readonly _decoder: StreamDecoder<TEvent, TMessage>;

  // Channel subscription — subscribe() returns a Promise that resolves when the channel attaches
  private readonly _attachPromise: Promise<unknown>;
  private readonly _onMessage: (msg: Ably.InboundMessage) => void;

  private _closed = false;

  constructor(options: ClientTransportOptions<TEvent, TMessage>) {
    this._channel = options.channel;
    this._codec = options.codec;
    this._clientId = options.clientId;
    this._api = options.api ?? '/api/chat';
    this._credentials = options.credentials;
    this._headersFn =
      typeof options.headers === 'function'
        ? options.headers
        : options.headers
          ? () => options.headers as Record<string, string>
          : undefined;
    this._bodyFn =
      typeof options.body === 'function'
        ? options.body
        : options.body
          ? () => options.body as Record<string, unknown>
          : undefined;
    this._fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ClientTransport',
    });

    this._emitter = new EventEmitter<ClientTransportEventsMap>(this._logger);

    // Compose sub-components
    this._tree = createConversationTree<TMessage>(this._codec.getMessageKey.bind(this._codec), this._logger);
    this._router = createStreamRouter<TEvent>(this._codec.isTerminal.bind(this._codec), this._logger);
    this._decoder = this._codec.createDecoder();

    // Seed tree with initial messages
    if (options.messages) {
      let prevMsgId: string | undefined;
      for (const msg of options.messages) {
        const msgId = this._codec.getMessageKey(msg);
        const seedHeaders: Record<string, string> = {};
        if (prevMsgId) seedHeaders[HEADER_PARENT] = prevMsgId;
        this._tree.upsert(msgId, msg, seedHeaders);
        prevMsgId = msgId;
      }
      this._emitter.emit('message');
    }

    // Spec: AIT-CT2
    // Subscribe before attach (RTL7g)
    this._onMessage = (ablyMessage: Ably.InboundMessage) => {
      this._handleMessage(ablyMessage);
    };
    this._attachPromise = this._channel.subscribe(this._onMessage);
  }

  // ---------------------------------------------------------------------------
  // Message subscription handler
  // ---------------------------------------------------------------------------

  private _handleMessage(ablyMessage: Ably.InboundMessage): void {
    if (this._closed) return;

    this._ablyMessages.push(ablyMessage);
    this._emitter.emit('ably-message');

    try {
      // Spec: AIT-CT16a
      // --- Turn lifecycle events from the server ---
      if (ablyMessage.name === EVENT_TURN_START) {
        const headers = getHeaders(ablyMessage);
        const turnId = headers[HEADER_TURN_ID];
        const turnCid = headers[HEADER_TURN_CLIENT_ID] ?? '';
        if (turnId) {
          this._turnClientIds.set(turnId, turnCid);
          this._emitter.emit('turn', { type: EVENT_TURN_START, turnId, clientId: turnCid });
        }
        return;
      }

      if (ablyMessage.name === EVENT_TURN_END) {
        const headers = getHeaders(ablyMessage);
        const turnId = headers[HEADER_TURN_ID];
        const turnCid = headers[HEADER_TURN_CLIENT_ID] ?? '';
        // CAST: server always writes a valid TurnEndReason; default to 'complete' for robustness
        const reason = (headers[HEADER_TURN_REASON] ?? 'complete') as TurnEndReason;
        if (turnId) {
          this._router.closeStream(turnId);
          this._turnObservers.delete(turnId);
          this._turnClientIds.delete(turnId);
          // Clean up per-turn relay-detection state
          const msgIds = this._turnMsgIds.get(turnId);
          if (msgIds) {
            for (const mid of msgIds) this._ownMsgIds.delete(mid);
            this._turnMsgIds.delete(turnId);
          }
          this._ownTurnIds.delete(turnId);
          this._emitter.emit('turn', { type: EVENT_TURN_END, turnId, clientId: turnCid, reason });
        }
        return;
      }

      // --- Codec-decoded messages ---
      const outputs = this._decoder.decode(ablyMessage);
      const headers = getHeaders(ablyMessage);
      const serial = ablyMessage.serial;

      // Always update observer headers, even when the decoder produces no outputs.
      // This ensures header transitions (e.g. x-ably-status: streaming → aborted)
      // are captured for events that the decoder suppresses (AIT-CD8: aborted
      // stream appends emit no events but still carry the updated status header).
      const turnId = headers[HEADER_TURN_ID];
      if (turnId) {
        this._updateTurnObserverHeaders(turnId, headers, serial);
      }

      for (const output of outputs) {
        if (output.kind === 'message') {
          this._handleMessageOutput(output.message, headers, serial, ablyMessage.action);
        } else {
          this._handleEventOutput(output, headers);
        }
      }
    } catch (error) {
      const cause = error instanceof Ably.ErrorInfo ? error : undefined;
      this._emitter.emit(
        'error',
        new Ably.ErrorInfo(
          `unable to process channel message; ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.TransportSubscriptionError,
          500,
          cause,
        ),
      );
    }
  }

  /**
   * Handle a decoded domain message (user message create or relayed own message).
   * @param message - The decoded domain message.
   * @param headers - Ably headers from the wire message.
   * @param serial - Ably serial for tree ordering.
   * @param action - Ably message action (e.g. 'message.create').
   */
  private _handleMessageOutput(
    message: TMessage,
    headers: Record<string, string>,
    serial: string | undefined,
    action: string | undefined,
  ): void {
    // Spec: AIT-CT15
    const msgId = headers[HEADER_MSG_ID];
    if (msgId && this._ownMsgIds.has(msgId)) {
      // Relayed own message — reconcile optimistic entry with server-assigned fields
      this._upsertAndNotify(message, headers, serial);
      return;
    }

    if (action === 'message.create') {
      this._upsertAndNotify(message, headers, serial);
    }
  }

  /**
   * Handle a decoded streaming event: route to own-turn stream or accumulate for observer.
   * @param output - The decoded event output from the codec.
   * @param headers - Ably headers from the wire message.
   */
  private _handleEventOutput(output: DecoderOutput<TEvent, TMessage>, headers: Record<string, string>): void {
    if (output.kind !== 'event') return;
    const event = output.event;
    const turnId = headers[HEADER_TURN_ID];
    if (!turnId) return;

    // Observer headers are already updated in _handleMessage (before outputs
    // are iterated) so that header transitions are captured even when the
    // decoder produces no outputs (e.g. aborted stream appends per AIT-CD8).

    // Active own turn — route to the ReadableStream
    if (this._router.route(turnId, event)) {
      this._accumulateAndEmit(turnId, output);
      if (this._codec.isTerminal(event)) this._turnObservers.delete(turnId);
      return;
    }

    // Completed own turn — late arrival, skip
    if (this._ownTurnIds.has(turnId) && !this._turnObservers.has(turnId)) return;

    // Spec: AIT-CT16
    // Observer turn — accumulate and emit
    this._accumulateAndEmit(turnId, output);
    if (this._codec.isTerminal(event)) this._turnObservers.delete(turnId);
  }

  // ---------------------------------------------------------------------------
  // Tree mutation + notification helpers
  // ---------------------------------------------------------------------------

  /**
   * Upsert a message into the tree and notify subscribers.
   * @param message - The domain message to insert or update.
   * @param headers - Ably headers for the message.
   * @param serial - Ably serial for tree ordering.
   */
  private _upsertAndNotify(message: TMessage, headers: Record<string, string>, serial?: string): void {
    const key = this._codec.getMessageKey(message);
    const msgId = headers[HEADER_MSG_ID] ?? key;
    this._tree.upsert(msgId, message, headers, serial);
    this._emitter.emit('message');
  }

  // ---------------------------------------------------------------------------
  // Observer accumulation
  // ---------------------------------------------------------------------------

  /**
   * Ensure a TurnObserverState exists for turnId, updating headers and serial as new events arrive.
   * @param turnId - The turn to track.
   * @param headers - Headers from the current event.
   * @param serial - Ably serial from the current event.
   */
  private _updateTurnObserverHeaders(
    turnId: string,
    headers: Record<string, string>,
    serial: string | undefined,
  ): void {
    const existing = this._turnObservers.get(turnId);
    if (existing) {
      if (Object.keys(headers).length > 0) {
        Object.assign(existing.headers, headers);
      }
      // Always advance the serial so the tree node sorts after all
      // earlier messages in the turn (e.g. user-message relays that
      // arrive before the assistant response).
      if (serial !== undefined) {
        existing.serial = serial;
      }
    } else {
      this._turnObservers.set(turnId, {
        headers: { ...headers },
        serial,
        accumulator: this._codec.createAccumulator(),
      });
    }
  }

  /**
   * Process a streaming event through the turn's accumulator and emit the latest message.
   * @param turnId - The turn this event belongs to.
   * @param output - The decoded event output to accumulate.
   */
  private _accumulateAndEmit(turnId: string, output: DecoderOutput<TEvent, TMessage>): void {
    const observer = this._turnObservers.get(turnId);
    if (!observer) return;

    observer.accumulator.processOutputs([output]);

    const messages = observer.accumulator.messages;
    if (messages.length === 0) return;

    let message: TMessage | undefined;
    try {
      message = structuredClone(messages.at(-1));
    } catch {
      // CAST: structuredClone can fail if the message contains non-cloneable
      // values (e.g. functions). Fall back to the reference — the tree upsert
      // below copies headers independently, so shared message state is the
      // only risk. Accumulator messages are replaced on each event, so
      // mutation between events is not a practical concern.
      message = messages.at(-1);
    }

    if (message) {
      this._tree.upsert(
        observer.headers[HEADER_MSG_ID] ?? this._codec.getMessageKey(message),
        message,
        { ...observer.headers },
        observer.serial,
      );
      this._emitter.emit('message');
    }
  }

  // ---------------------------------------------------------------------------
  // Cancel helpers
  // ---------------------------------------------------------------------------

  private async _publishCancel(filter: CancelFilter): Promise<void> {
    this._logger.trace('ClientTransport._publishCancel();', { filter });

    const headers: Record<string, string> = {};
    if (filter.turnId) {
      headers[HEADER_CANCEL_TURN_ID] = filter.turnId;
    } else if (filter.own) {
      headers[HEADER_CANCEL_OWN] = 'true';
    } else if (filter.clientId) {
      headers[HEADER_CANCEL_CLIENT_ID] = filter.clientId;
    } else if (filter.all) {
      headers[HEADER_CANCEL_ALL] = 'true';
    }

    await this._channel.publish({
      name: EVENT_CANCEL,
      extras: { headers },
    });
  }

  private _closeMatchingTurnStreams(filter: CancelFilter): void {
    // Only close the router streams here — do NOT clear _turnObservers.
    // The observer must remain alive so that late server events (e.g. abort,
    // x-ably-status: aborted) arriving before turn-end are still accumulated
    // into the message store. The turn-end handler cleans up observers.
    if (filter.all) {
      for (const turnId of this._ownTurnIds) {
        this._router.closeStream(turnId);
      }
    } else if (filter.own) {
      for (const tid of this._ownTurnIds) {
        this._router.closeStream(tid);
      }
    } else if (filter.clientId) {
      for (const [tid, cid] of this._turnClientIds) {
        if (cid === filter.clientId) {
          this._router.closeStream(tid);
        }
      }
    } else if (filter.turnId) {
      this._router.closeStream(filter.turnId);
    }
  }

  private _getMatchingTurnIds(filter: CancelFilter): Set<string> {
    const matched = new Set<string>();
    if (filter.all) {
      for (const turnId of this._turnClientIds.keys()) matched.add(turnId);
    } else if (filter.own) {
      for (const [turnId, cid] of this._turnClientIds) {
        if (cid === this._clientId) matched.add(turnId);
      }
    } else if (filter.clientId) {
      for (const [turnId, cid] of this._turnClientIds) {
        if (cid === filter.clientId) matched.add(turnId);
      }
    } else if (filter.turnId && this._turnClientIds.has(filter.turnId)) {
      matched.add(filter.turnId);
    }
    return matched;
  }

  // ---------------------------------------------------------------------------
  // Input message helpers
  // ---------------------------------------------------------------------------

  private _getMessagesWithHeaders(): MessageWithHeaders<TMessage>[] {
    return this._tree.flatten().map((m) => ({
      message: m,
      headers: this.getMessageHeaders(m),
    }));
  }

  /**
   * Compute truncated history: everything before the target message.
   * Used by regenerate so the LLM doesn't see the response being replaced.
   * @param messageId - The msg-id to truncate history before.
   * @returns Input messages preceding the target.
   */
  private _getHistoryBefore(messageId: string): MessageWithHeaders<TMessage>[] {
    const all = this._getMessagesWithHeaders();
    const idx = all.findIndex((inp) => inp.headers?.[HEADER_MSG_ID] === messageId);
    return idx === -1 ? all : all.slice(0, idx);
  }

  // ---------------------------------------------------------------------------
  // History pagination helpers
  // ---------------------------------------------------------------------------

  private _processHistoryPage(page: PaginatedMessages<TMessage>): void {
    for (const [i, message] of page.items.entries()) {
      const headers = page.itemHeaders?.[i] ?? {};
      const serial = page.itemSerials?.[i];
      const key = this._codec.getMessageKey(message);
      const msgId = headers[HEADER_MSG_ID] ?? key;
      this._tree.upsert(msgId, message, headers, serial);
    }
    this._emitter.emit('message');

    // Prepend raw Ably messages (older messages go at the beginning)
    if (page.rawMessages && page.rawMessages.length > 0) {
      this._ablyMessages.unshift(...page.rawMessages);
      this._emitter.emit('ably-message');
    }
  }

  private async _loadUntilVisible(
    firstPage: PaginatedMessages<TMessage>,
    target: number,
    beforeKeys: Set<string>,
  ): Promise<{ newVisible: TMessage[]; lastPage: PaginatedMessages<TMessage> }> {
    this._processHistoryPage(firstPage);
    let page = firstPage;

    const newVisibleCount = (): number => {
      let count = 0;
      for (const m of this._tree.flatten()) {
        if (!beforeKeys.has(this._codec.getMessageKey(m))) count++;
      }
      return count;
    };

    while (newVisibleCount() < target && page.hasNext()) {
      const nextPage = await page.next();
      if (!nextPage) break;
      this._processHistoryPage(nextPage);
      page = nextPage;
    }

    const newVisible = this._tree.flatten().filter((m) => !beforeKeys.has(this._codec.getMessageKey(m)));
    return { newVisible, lastPage: page };
  }

  private _releaseWithheld(messages: TMessage[]): void {
    for (const m of messages) {
      this._withheldKeys.delete(this._codec.getMessageKey(m));
    }
    if (messages.length > 0) {
      this._emitter.emit('message');
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT3, AIT-CT4
  async send(input: TMessage | TMessage[], sendOptions?: SendOptions): Promise<ActiveTurn<TEvent>> {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to send; transport is closed', ErrorCode.TransportClosed, 400);
    }
    await this._attachPromise;
    // CAST: re-check after await — close() may have been called while waiting for attach.
    // TypeScript's control flow narrows _closed to false after the first check, but the
    // await yields and close() can mutate _closed concurrently.
    if (this._closed as boolean) {
      throw new Ably.ErrorInfo('unable to send; transport is closed', ErrorCode.TransportClosed, 400);
    }

    this._logger.trace('ClientTransport.send();');

    const msgs = Array.isArray(input) ? input : [input];
    const turnId = crypto.randomUUID();
    this._ownTurnIds.add(turnId);

    const msgIds = new Set<string>();
    const postMessages: { message: TMessage; headers: Record<string, string> }[] = [];

    // Capture history BEFORE optimistic inserts. The optimistic messages are
    // sent in the `messages` field — including them in `history` too would
    // cause the server to see them twice.
    const preInsertHistory = this._getMessagesWithHeaders();

    // Spec: AIT-CT3d
    // Auto-compute parent from the current thread if not explicitly provided
    let autoParent: string | undefined;
    if (sendOptions?.parent === undefined && !sendOptions?.forkOf) {
      const flat = this._tree.flatten();
      if (flat.length > 0) {
        const lastMsg = flat.at(-1);
        if (lastMsg) {
          const lastKey = this._codec.getMessageKey(lastMsg);
          const lastNode = this._tree.getNodeByKey(lastKey);
          autoParent = lastNode?.msgId ?? lastKey;
        }
      }
    }

    // Capture the first parent for the POST body before the loop advances it.
    const postParent = sendOptions?.parent === undefined ? autoParent : sendOptions.parent;

    for (const message of msgs) {
      const msgId = crypto.randomUUID();
      this._ownMsgIds.add(msgId);
      msgIds.add(msgId);

      const resolvedParent = sendOptions?.parent === undefined ? autoParent : (sendOptions.parent ?? undefined);

      const optimisticHeaders = buildTransportHeaders({
        role: 'user',
        turnId,
        msgId,
        turnClientId: this._clientId,
        parent: resolvedParent,
        forkOf: sendOptions?.forkOf,
      });
      // Spec: AIT-CT3c
      // Optimistically insert each user message into the tree
      this._upsertAndNotify(message, optimisticHeaders);

      // Include per-message parent so the server chains messages correctly.
      const postHeaders: Record<string, string> = { [HEADER_MSG_ID]: msgId, [HEADER_ROLE]: 'user' };
      if (resolvedParent) postHeaders[HEADER_PARENT] = resolvedParent;
      postMessages.push({ message, headers: postHeaders });

      // Spec: AIT-CT3e
      // Chain: each subsequent message in the batch parents off the previous
      // one, forming a linear conversation thread rather than siblings.
      if (sendOptions?.parent === undefined && !sendOptions?.forkOf) {
        autoParent = msgId;
      }
    }

    this._turnMsgIds.set(turnId, msgIds);

    // Create ReadableStream via router
    const stream = this._router.createStream(turnId);

    // Resolve headers and body
    const resolvedHeaders = this._headersFn?.() ?? {};
    const resolvedBody = this._bodyFn?.() ?? {};

    const postBody: Record<string, unknown> = {
      ...resolvedBody,
      history: preInsertHistory,
      ...sendOptions?.body,
      turnId,
      clientId: this._clientId,
      messages: postMessages,
      ...(sendOptions?.forkOf !== undefined && { forkOf: sendOptions.forkOf }),
      ...(postParent !== undefined && { parent: postParent }),
    };

    const postHeaders: Record<string, string> = {
      ...resolvedHeaders,
      ...sendOptions?.headers,
    };

    // Spec: AIT-CT3a, AIT-CT3b
    // Fire-and-forget: POST must not block the stream return to the caller.
    // .catch() is intentional — async/await would delay stream availability.
    this._fetchFn(this._api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...postHeaders,
      },
      body: JSON.stringify(postBody),
      ...(this._credentials ? { credentials: this._credentials } : {}),
    })
      .then((response) => {
        if (!response.ok) {
          this._emitter.emit(
            'error',
            new Ably.ErrorInfo(
              `unable to send; HTTP POST to ${this._api} returned ${String(response.status)} ${response.statusText}`,
              ErrorCode.TransportSendFailed,
              response.status,
            ),
          );
          this._router.closeStream(turnId);
        }
      })
      .catch((error: unknown) => {
        const cause = error instanceof Ably.ErrorInfo ? error : undefined;
        this._emitter.emit(
          'error',
          new Ably.ErrorInfo(
            `unable to send; HTTP POST to ${this._api} failed: ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.TransportSendFailed,
            500,
            cause,
          ),
        );
        this._router.closeStream(turnId);
      });

    return {
      stream,
      turnId,
      cancel: async () => this.cancel({ turnId }),
    };
  }

  // Spec: AIT-CT5
  async regenerate(messageId: string, sendOptions?: SendOptions): Promise<ActiveTurn<TEvent>> {
    this._logger.trace('ClientTransport.regenerate();', { messageId });

    const node = this._tree.getNode(messageId);
    const parentId = node?.parentId;

    return this.send([], {
      ...sendOptions,
      body: {
        history: this._getHistoryBefore(messageId),
        ...sendOptions?.body,
      },
      forkOf: messageId,
      parent: parentId,
    });
  }

  // Spec: AIT-CT6
  async edit(
    messageId: string,
    newMessages: TMessage | TMessage[],
    sendOptions?: SendOptions,
  ): Promise<ActiveTurn<TEvent>> {
    this._logger.trace('ClientTransport.edit();', { messageId });

    const node = this._tree.getNode(messageId);
    const parentId = node?.parentId;

    return this.send(newMessages, {
      ...sendOptions,
      body: {
        history: this._getHistoryBefore(messageId),
        ...sendOptions?.body,
      },
      forkOf: messageId,
      parent: parentId,
    });
  }

  // Spec: AIT-CT7, AIT-CT7a
  async cancel(filter?: CancelFilter): Promise<void> {
    if (this._closed) return;
    const resolved = filter ?? { own: true };
    this._logger.debug('ClientTransport.cancel();', { filter: resolved });
    await this._publishCancel(resolved);
    this._closeMatchingTurnStreams(resolved);
  }

  // Spec: AIT-CT18
  async waitForTurn(filter?: CancelFilter): Promise<void> {
    if (this._closed) return;
    const resolved = filter ?? { own: true };
    const remaining = this._getMatchingTurnIds(resolved);
    if (remaining.size === 0) return;

    this._logger.debug('ClientTransport.waitForTurn();', { turnIds: [...remaining] });

    return new Promise<void>((resolve) => {
      const handler = (event: TurnLifecycleEvent): void => {
        if (event.type !== EVENT_TURN_END) return;
        remaining.delete(event.turnId);
        if (remaining.size === 0) {
          this._emitter.off('turn', handler);
          resolve();
        }
      };
      this._emitter.on('turn', handler);
    });
  }

  // Spec: AIT-CT8, AIT-CT8a, AIT-CT8b, AIT-CT8c, AIT-CT8d
  on(event: 'message' | 'ably-message', handler: () => void): () => void;
  on(event: 'turn', handler: (event: TurnLifecycleEvent) => void): () => void;
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;
  on(
    eventName: 'message' | 'turn' | 'error' | 'ably-message',
    handler: (() => void) | ((event: TurnLifecycleEvent) => void) | ((error: Ably.ErrorInfo) => void),
  ): () => void {
    if (this._closed) return noopUnsubscribe;
    // CAST: the overload signatures enforce correct handler types per event name.
    // The implementation must cast to satisfy the EventEmitter's generic callback type.
    const cb = handler as (arg: ClientTransportEventsMap[keyof ClientTransportEventsMap]) => void;
    this._emitter.on(eventName, cb);
    return () => {
      this._emitter.off(eventName, cb);
    };
  }

  // Spec: AIT-CT10
  getTree(): ConversationTree<TMessage> {
    return this._tree;
  }

  // Spec: AIT-CT17
  getActiveTurnIds(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const [turnId, cid] of this._turnClientIds) {
      let set = result.get(cid);
      if (!set) {
        set = new Set();
        result.set(cid, set);
      }
      set.add(turnId);
    }
    return result;
  }

  getMessageHeaders(message: TMessage): Record<string, string> | undefined {
    const key = this._codec.getMessageKey(message);
    return this._tree.getNodeByKey(key)?.headers;
  }

  // Spec: AIT-CT9
  getMessages(): TMessage[] {
    if (this._withheldKeys.size === 0) return this._tree.flatten();
    return this._tree.flatten().filter((m) => !this._withheldKeys.has(this._codec.getMessageKey(m)));
  }

  getMessagesWithHeaders(): MessageWithHeaders<TMessage>[] {
    return this._getMessagesWithHeaders();
  }

  getAblyMessages(): Ably.InboundMessage[] {
    return [...this._ablyMessages];
  }

  // Spec: AIT-CT11, AIT-CT11a, AIT-CT11b, AIT-CT11c
  async history(opts?: LoadHistoryOptions): Promise<PaginatedMessages<TMessage>> {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to load history; transport is closed', ErrorCode.TransportClosed, 400);
    }
    this._logger.trace('ClientTransport.history();', { limit: opts?.limit });
    const limit = opts?.limit ?? 100;

    // Snapshot before loading — everything already in the tree stays visible
    const beforeKeys = new Set(this._tree.flatten().map((m) => this._codec.getMessageKey(m)));

    let lastPage = await decodeHistory(this._channel, this._codec, opts, this._logger);

    const initial = await this._loadUntilVisible(lastPage, limit, beforeKeys);
    lastPage = initial.lastPage;

    // newVisible is chronological (oldest-first from flatten).
    // For "load older" pagination: release the NEWEST `limit` now,
    // withhold the older ones for subsequent next() calls.
    const newVisible = initial.newVisible;

    // Withhold ALL new visible messages first, then release the newest batch
    for (const m of newVisible) {
      this._withheldKeys.add(this._codec.getMessageKey(m));
    }

    const released = newVisible.slice(-limit);
    // Mutable buffer of older messages, drained newest-first by successive next() calls
    const withheldBuffer = newVisible.slice(0, -limit);
    this._releaseWithheld(released);

    const buildPage = (items: TMessage[]): PaginatedMessages<TMessage> => ({
      items,
      hasNext: () => withheldBuffer.length > 0 || lastPage.hasNext(),
      next: async () => {
        // Drain withheld buffer first (older messages, released newest-first)
        if (withheldBuffer.length > 0) {
          // Remove and return the newest `limit` items from the buffer
          const batch = withheldBuffer.splice(-limit, limit);
          this._releaseWithheld(batch);
          return buildPage(batch);
        }

        // Buffer exhausted — load more pages from decodeHistory
        if (!lastPage.hasNext()) return;

        const nextInternal = await lastPage.next();
        if (!nextInternal) return;

        // Everything currently in the tree is "already known"
        const alreadyKnown = new Set(beforeKeys);
        for (const m of this._tree.flatten()) {
          alreadyKnown.add(this._codec.getMessageKey(m));
        }

        const loaded = await this._loadUntilVisible(nextInternal, limit, alreadyKnown);
        lastPage = loaded.lastPage;

        const moreVisible = loaded.newVisible;
        for (const m of moreVisible) {
          this._withheldKeys.add(this._codec.getMessageKey(m));
        }
        // Remove and return the newest `limit` items; rest stays in buffer
        const moreBatch = moreVisible.splice(-limit, limit);
        withheldBuffer.push(...moreVisible);
        this._releaseWithheld(moreBatch);

        if (moreBatch.length === 0) return;
        return buildPage(moreBatch);
      },
    });

    return buildPage(released);
  }

  // Spec: AIT-CT12, AIT-CT12a, AIT-CT12b
  async close(options?: CloseOptions): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._logger.info('ClientTransport.close();');

    // Best-effort cancel publish before tearing down local state
    if (options?.cancel) {
      try {
        await this._publishCancel(options.cancel);
      } catch {
        // Swallow: cancel is best-effort during teardown
      }
      this._closeMatchingTurnStreams(options.cancel);
    }

    this._channel.unsubscribe(this._onMessage);

    // Close any remaining active streams
    for (const turnId of this._ownTurnIds) {
      this._router.closeStream(turnId);
    }

    this._turnObservers.clear();
    this._emitter.off();
    this._ownTurnIds.clear();
    this._ownMsgIds.clear();
    this._turnMsgIds.clear();
    this._turnClientIds.clear();
    this._withheldKeys.clear();
    this._ablyMessages.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a client-side transport that manages conversation state over an Ably channel.
 *
 * Subscribes to the channel immediately (before attach per RTL7g). The caller should
 * ensure the channel is attached or will be attached shortly after creation.
 * @param options - Configuration for the client transport.
 * @returns A new {@link ClientTransport} instance.
 */
export const createClientTransport = <TEvent, TMessage>(
  options: ClientTransportOptions<TEvent, TMessage>,
): ClientTransport<TEvent, TMessage> => new DefaultClientTransport(options);
