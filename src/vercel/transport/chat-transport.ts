/**
 * A `ChatTransport` for `useChat`, built directly on the standalone
 * {@link ClientTransport}. It holds no conversation state and folds nothing:
 * the UI is driven exclusively through useChat, and this adapter turns the
 * channel's decoded event stream into the `ReadableStream<UIMessageChunk>`
 * useChat consumes, and turns useChat's sends into channel publishes plus an
 * HTTP POST that wakes the agent route.
 *
 * Send paths:
 *
 * - **Fresh send** (last message is the new user message): publish the message
 *   body as a codec input, then POST the invocation pointer
 *   `{channelName, eventId}` — the agent locates the input in channel history
 *   and opens a fresh run.
 * - **Continuation** (last message is an assistant with tool parts the user
 *   just resolved): publish one action per resolved tool part not yet
 *   published — a tool-output chunk body, or the approval-decision body —
 *   addressed to the assistant's wire codec-message-id, then POST
 *   `{channelName, eventId, runId}` — the agent resumes that run. Actions are
 *   published only on `sendMessages`, never spontaneously on observing a
 *   resolved part, so a hydrated page cannot re-trigger a continuation for
 *   work already done.
 * - **Regeneration** (`trigger: 'regenerate-message'`): publish the codec's
 *   wire-only regenerate input with the `regenerates` / `parent` structure
 *   taken from the message array useChat hands over, then POST a fresh run.
 *
 * The adapter keeps two things off {@link WireMeta}, neither of them a fold:
 * an index from a message's domain id to the `codecMessageId` and `runId` the
 * wire already carries on every event (needed only for messages this client
 * did not publish — its own sends learn both from the publish result), and
 * the set of `toolCallId`s an action has already been published for. Seed
 * both from history via {@link ChatTransport.seed} so a reloaded page can
 * resume a run that suspended before the page loaded.
 */

// Named import for the one SDK type used in an `extends` heritage clause: the
// `import-x/namespace` rule can't verify a namespaced generic there. Everywhere
// else the `AI.*` namespace is used.
import type * as Ably from 'ably';
import type * as AI from 'ai';
import type { ChatTransport as SdkChatTransport } from 'ai';

import type { ClientTransport, TransportEvent } from '../../core/transport/types.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import { LogLevel, makeLogger } from '../../logger.js';
import type { VercelInput, VercelOutput } from '../codec/events.js';
import { isToolPart } from '../tool-part.js';

/** Default page bound for the {@link ChatTransport.reconnectToStream} history scan. */
const DEFAULT_RECONNECT_SCAN_PAGES = 5;

/**
 * Best-effort cancel: a failed cancel publish is unrecoverable here, and the
 * stream still closes on the run's own end event.
 */
const swallowCancelFailure = (): void => {
  /* best-effort */
};

/** The response body of a POST to the chat route. */
interface ChatResponseBody {
  /** The id of the run the agent opened (or resumed) for this send. */
  runId: string;
}

/** One classified event off the client transport, at the adapter's instantiation. */
type AdapterEvent<TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools> = TransportEvent<
  VercelInput<TMetadata, TDataParts, TTools>,
  VercelOutput<TMetadata, TDataParts>
>;

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
  /**
   * Page bound for the {@link ChatTransport.reconnectToStream} history scan.
   * A run whose `ai-run-start` lies beyond the bound cannot be classified and
   * is not resumed. Defaults to 5 pages.
   */
  reconnectScanPages?: number;
}

/**
 * The `useChat` transport surface this adapter implements: the AI SDK's own
 * `ChatTransport` (so it drops straight into `useChat({ transport })`), plus
 * {@link ChatTransport.seed} for hydration, `close()` to stop delivery, and
 * `streaming` / `onStreamingChange` so a consumer can observe whether a run
 * is in flight.
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
   * Seed the adapter's wire indices from history events the application
   * already read (its hydration pass): the domain-id to codec-message-id and
   * run-id index, and the published-`toolCallId` set. Call it once, after
   * hydration; live events observed before the call are held back and indexed
   * after the (strictly older) seed events, keeping the indices chronological.
   * Seeding is what stops a reloaded page from re-publishing a resolution an
   * earlier session already published.
   *
   * Live indexing WAITS for this call, so an application that does no
   * hydration must still call `seed([])` once on mount — without it, the
   * adapter never learns the wire identities its continuations address.
   * @param events - The hydrated history events, oldest-first.
   */
  seed(events: TransportEvent<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>>[]): void;
  /**
   * Stop the adapter's event delivery and close any open run streams. The
   * underlying client transport is caller-owned and is not closed.
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
}

/** Internal event map backing the adapter's streaming state. */
interface StreamingEvents {
  /** Fired on every streaming-state transition with the new value. */
  streaming: boolean;
}

/** The wire identity the adapter keeps per domain message id. */
interface WireIdentity {
  /** The message's wire codec-message-id — what an action addresses. */
  codecMessageId: string;
  /** The run the message was published under, or `undefined` for a run-less input. */
  runId: string | undefined;
}

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
  private readonly _reconnectScanPages: number;

  /** Domain message id → the wire identity every event already carries on its meta. */
  private readonly _wireIdentityByMessageId = new Map<string, WireIdentity>();
  /** Tool calls an action has already been published for (by any client, or seeded from history). */
  private readonly _publishedToolCallIds = new Set<string>();
  /** The newest assistant's wire identity, for a regenerate that names no message. */
  private _newestAssistant: WireIdentity | undefined;
  /** Active run-stream collectors fed from the live event subscription. */
  private readonly _collectors = new Set<(event: AdapterEvent<TMetadata, TDataParts, TTools>) => void>();
  /** Live events held back until {@link seed} indexes the older history first; `undefined` once seeded. */
  private _preSeedEvents: AdapterEvent<TMetadata, TDataParts, TTools>[] | undefined = [];
  /** Per-open-stream failure hooks: channel continuity loss errors every open stream. */
  private readonly _streamFailers = new Set<(error: Ably.ErrorInfo) => void>();
  private readonly _unsubscribeError: () => void;
  private readonly _emitter = new EventEmitter<StreamingEvents>(makeLogger({ logLevel: LogLevel.Silent }));
  private _openStreams = 0;
  private _closed = false;
  private readonly _unsubscribe: () => void;

  constructor(options: ChatTransportOptions<TMetadata, TDataParts, TTools>) {
    this._transport = options.transport;
    this._channelName = options.channelName;
    this._api = options.api ?? '/api/chat';
    this._reconnectScanPages = options.reconnectScanPages ?? DEFAULT_RECONNECT_SCAN_PAGES;
    this._unsubscribe = this._transport.subscribe((event) => {
      if (this._preSeedEvents === undefined) this._indexEvent(event);
      else this._preSeedEvents.push(event);
      for (const collector of this._collectors) collector(event);
    });
    // Channel continuity loss means the stream can silently miss its run's
    // terminal, so error every open stream rather than leaving useChat stuck
    // on `streaming`. Other transport errors (a single decode failure, a
    // cancel-publish failure) drop one message and are not stream-fatal.
    this._unsubscribeError = this._transport.on('error', (error) => {
      if (!errorInfoIs(error, ErrorCode.SessionContinuityNotGuaranteed)) return;
      for (const fail of this._streamFailers) fail(error);
    });
  }

  seed(events: AdapterEvent<TMetadata, TDataParts, TTools>[]): void {
    for (const event of events) this._indexEvent(event);
    const heldBack = this._preSeedEvents ?? [];
    this._preSeedEvents = undefined;
    for (const event of heldBack) this._indexEvent(event);
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

  close(): void {
    this._closed = true;
    this._unsubscribe();
    this._unsubscribeError();
    this._collectors.clear();
    this._streamFailers.clear();
    if (this._openStreams > 0) {
      this._openStreams = 0;
      this._emitter.emit('streaming', false);
    }
  }

  async sendMessages(
    options: Parameters<SdkChatTransport<AI.UIMessage<TMetadata, TDataParts, TTools>>['sendMessages']>[0],
  ): Promise<ReadableStream<AI.UIMessageChunk>> {
    if (options.trigger === 'regenerate-message') {
      return this._sendRegenerate(options.messages, options.messageId, options.abortSignal);
    }
    const last = options.messages.at(-1);
    if (!last) throw new Error('unable to send; no messages');
    if (last.role === 'assistant') {
      return this._sendContinuation(options.messages, options.abortSignal);
    }
    return this._sendFresh(last, options.abortSignal);
  }

  async reconnectToStream(): Promise<ReadableStream<AI.UIMessageChunk> | null> {
    // Subscribe before paging, so nothing published during the scan is lost:
    // history() is bounded at the attach point and shares the live decoder, so
    // the buffered live events are strictly newer than every page and the seam
    // needs no dedup.
    const live: AdapterEvent<TMetadata, TDataParts, TTools>[] = [];
    const buffer = (event: AdapterEvent<TMetadata, TDataParts, TTools>): void => {
      live.push(event);
    };
    this._collectors.add(buffer);

    try {
      // Page backwards, oldest batch first in `all`, until the resumable run —
      // the newest run whose latest lifecycle event is a start or resume — is
      // classified with its whole replay in hand, or the scan is exhausted or
      // hits its bound.
      let all: AdapterEvent<TMetadata, TDataParts, TTools>[] = [];
      let exhausted = false;
      for (let page = 0; page < this._reconnectScanPages && !exhausted; page++) {
        const batch = await this._transport.history();
        all = [...batch.events, ...all];
        exhausted = batch.exhausted;

        const target = this._classifyResumableRun(all);
        if (target === undefined) continue;
        // eslint-disable-next-line unicorn/no-null -- null is required by the AI SDK ChatTransport contract
        if (target.runId === undefined) return null;
        return this._buildReconnectStream(target.runId, all, live, buffer);
      }
      // The scan ended without classifying a run: no lifecycle event at all
      // (nothing to resume), or an open run whose start lies beyond the bound
      // (unclassifiable — the adapter cannot tell an open run from one whose
      // end it never saw).
      // eslint-disable-next-line unicorn/no-null -- null is required by the AI SDK ChatTransport contract
      return null;
    } finally {
      // The buffer either handed over to the reconnect stream (which removed
      // it itself) or is dropped here on the null paths.
      this._collectors.delete(buffer);
    }
  }

  /**
   * Classify the resumable run from the scanned events, newest first.
   * @param all - Every scanned event, oldest first.
   * @returns `undefined` to keep paging; `{ runId: undefined }` when there is
   *   definitively nothing to resume; the run id when a resumable run's whole
   *   replay is in hand.
   */
  private _classifyResumableRun(all: AdapterEvent<TMetadata, TDataParts, TTools>[]): { runId?: string } | undefined {
    // Latest lifecycle state per run, and the runs' recency order (newest first).
    const latest = new Map<string, 'start' | 'suspend' | 'resume' | 'end'>();
    const started = new Set<string>();
    const order: string[] = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const event = all[i];
      if (event?.kind !== 'run-lifecycle') continue;
      const { runId, type } = event.event;
      if (!latest.has(runId)) {
        latest.set(runId, type);
        order.push(runId);
      }
      if (type === 'start') started.add(runId);
    }
    if (latest.size === 0) return undefined;

    // The newest run whose latest lifecycle event leaves it open. A suspended
    // run is waiting on the client (useChat drives that through the
    // continuation path), and an ended run has nothing to stream.
    const candidate = order.find((runId) => {
      const state = latest.get(runId);
      return state === 'start' || state === 'resume';
    });
    if (candidate === undefined) return { runId: undefined };
    // Replay needs everything from the run's start onward; keep paging until
    // its `ai-run-start` is inside the scan.
    if (!started.has(candidate)) return undefined;
    return { runId: candidate };
  }

  /**
   * Build the reconnect stream: replay the run's output chunks from the
   * scanned history, then go live, filtered by the run id. Closes on a
   * terminal chunk (`finish` / `error` / `abort`), on the run's end, or on its
   * suspend (a suspended run is continued through `sendMessages`, not a
   * stream).
   * @param runId - The resumable run.
   * @param all - Every scanned event, oldest first (the replay source).
   * @param buffered - Live events collected while the scan paged.
   * @param scanBuffer - The scan's collector, replaced by the stream's own.
   * @returns The chunk stream for useChat.
   */
  private _buildReconnectStream(
    runId: string,
    all: AdapterEvent<TMetadata, TDataParts, TTools>[],
    buffered: AdapterEvent<TMetadata, TDataParts, TTools>[],
    scanBuffer: (event: AdapterEvent<TMetadata, TDataParts, TTools>) => void,
  ): ReadableStream<AI.UIMessageChunk> {
    // The collector's own subscription takes over from the scan buffer, so
    // every live event lands exactly once: in `buffered` (scan-time), or in
    // the collector (from here on).
    const collector = this._openRunStream();
    this._collectors.delete(scanBuffer);
    // Replay history, then the strictly-newer live events the scan buffered,
    // then whatever the collector itself buffered — `setRunId`'s own flush.
    collector.setRunId(runId, [...all, ...buffered]);
    return collector.stream;
  }

  /**
   * Publish the new user message and wake the agent with a fresh-run POST.
   * @param message - The new user message useChat appended.
   * @param abortSignal - useChat's per-send abort signal.
   * @returns The run's chunk stream.
   */
  private async _sendFresh(
    message: AI.UIMessage<TMetadata, TDataParts, TTools>,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<AI.UIMessageChunk>> {
    const collector = this._openRunStream(abortSignal);
    try {
      const sent = await this._transport.publishInput({ kind: 'message', payload: message });
      // Index the send locally: the publish result already names both ids.
      this._wireIdentityByMessageId.set(message.id, { codecMessageId: sent.codecMessageId, runId: undefined });
      const response = await this._postChat({ eventId: sent.eventId });
      collector.setRunId(response.runId);
    } catch (error) {
      collector.dispose();
      throw error;
    }
    return collector.stream;
  }

  /**
   * Publish one action per newly resolved tool part under the suspended run,
   * then wake the agent.
   * @param messages - useChat's current message list.
   * @param abortSignal - useChat's per-send abort signal.
   * @returns The resumed run's chunk stream.
   */
  private async _sendContinuation(
    messages: AI.UIMessage<TMetadata, TDataParts, TTools>[],
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<AI.UIMessageChunk>> {
    const continuation = this._deriveContinuation(messages);
    if (continuation === undefined) {
      // Every tool part is already resolved on the wire (e.g. another client
      // answered first) — nothing to publish, so hand useChat a closed stream.
      return new ReadableStream<AI.UIMessageChunk>({
        start(controller) {
          controller.close();
        },
      });
    }
    const { actions, runId } = continuation;
    const collector = this._openRunStream(abortSignal);
    try {
      let eventId = '';
      for (const action of actions) {
        const sent = await this._transport.publishInput(action.input, {
          codecMessageId: action.codecMessageId,
          runId,
        });
        this._publishedToolCallIds.add(action.toolCallId);
        eventId = sent.eventId;
      }
      const response = await this._postChat({ eventId, runId });
      collector.setRunId(response.runId);
    } catch (error) {
      collector.dispose();
      throw error;
    }
    return collector.stream;
  }

  /**
   * Publish the wire-only regenerate input and wake the agent with a
   * fresh-run POST.
   * @param messages - useChat's truncated message list.
   * @param messageId - The regenerated assistant's domain id, when useChat names one.
   * @param abortSignal - useChat's per-send abort signal.
   * @returns The new run's chunk stream.
   */
  private async _sendRegenerate(
    messages: AI.UIMessage<TMetadata, TDataParts, TTools>[],
    messageId: string | undefined,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<AI.UIMessageChunk>> {
    // The regeneration target: the named assistant, or — when useChat names
    // none — the newest assistant observed on the wire (useChat has already
    // truncated the array at the regeneration target, so the target itself is
    // not in `messages`).
    const target = messageId === undefined ? this._newestAssistant : this._wireIdentityByMessageId.get(messageId);
    if (target === undefined) {
      throw new Error('unable to regenerate; no wire identity known for the regeneration target');
    }
    // The new assistant threads under the last message useChat kept — the
    // user message that preceded the regenerated assistant.
    const parentDomainId = messages.at(-1)?.id;
    const parent = parentDomainId === undefined ? undefined : this._wireIdentityByMessageId.get(parentDomainId);

    const collector = this._openRunStream(abortSignal);
    try {
      const sent = await this._transport.publishInput(
        { kind: 'regenerate' },
        {
          regenerates: target.codecMessageId,
          ...(parent === undefined ? {} : { parent: parent.codecMessageId }),
        },
      );
      const response = await this._postChat({ eventId: sent.eventId });
      collector.setRunId(response.runId);
    } catch (error) {
      collector.dispose();
      throw error;
    }
    return collector.stream;
  }

  /**
   * Diff useChat's overlay tool parts against the published set and build one
   * action per resolved part not yet published: the approval-decision body for
   * an `approval-responded` part, or the provider's own tool-output chunk for
   * an `output-available` / `output-error` part. Each action addresses the
   * assistant's wire codec-message-id and names the run to continue.
   * @param messages - useChat's current message list.
   * @returns The actions and the suspended run's id, or `undefined` when nothing needs publishing.
   */
  private _deriveContinuation(messages: AI.UIMessage<TMetadata, TDataParts, TTools>[]):
    | {
        actions: {
          input: VercelInput<TMetadata, TDataParts, TTools>;
          codecMessageId: string;
          toolCallId: string;
        }[];
        runId: string;
      }
    | undefined {
    const actions: { input: VercelInput<TMetadata, TDataParts, TTools>; codecMessageId: string; toolCallId: string }[] =
      [];
    let runId: string | undefined;

    for (const overlay of messages) {
      if (overlay.role !== 'assistant') continue;
      const identity = this._wireIdentityByMessageId.get(overlay.id);
      if (!identity) continue;

      for (const overlayPart of overlay.parts) {
        if (!isToolPart(overlayPart)) continue;
        if (this._publishedToolCallIds.has(overlayPart.toolCallId)) continue;

        let input: VercelInput<TMetadata, TDataParts, TTools> | undefined;
        switch (overlayPart.state) {
          case 'approval-responded': {
            input = {
              kind: 'approval',
              payload: {
                toolCallId: overlayPart.toolCallId,
                approved: overlayPart.approval.approved,
                ...(overlayPart.approval.reason === undefined ? {} : { reason: overlayPart.approval.reason }),
              },
            };

            break;
          }
          case 'output-available': {
            input = {
              kind: 'chunk',
              payload: {
                type: 'tool-output-available',
                toolCallId: overlayPart.toolCallId,
                output: overlayPart.output,
                ...(overlayPart.type === 'dynamic-tool' ? { dynamic: true } : {}),
              },
            };

            break;
          }
          case 'output-error': {
            input = {
              kind: 'chunk',
              payload: {
                type: 'tool-output-error',
                toolCallId: overlayPart.toolCallId,
                errorText: overlayPart.errorText,
                ...(overlayPart.type === 'dynamic-tool' ? { dynamic: true } : {}),
              },
            };

            break;
          }
          // No default
        }
        if (input === undefined) continue;
        actions.push({ input, codecMessageId: identity.codecMessageId, toolCallId: overlayPart.toolCallId });
        runId ??= identity.runId;
      }
    }

    if (actions.length === 0) return undefined;
    if (runId === undefined) {
      throw new Error('unable to continue; no run-id known for the suspended assistant message');
    }
    return { actions, runId };
  }

  /**
   * Index one wire event: record the domain-id to wire-identity pairing every
   * message event already carries, and mark tool calls whose resolution is on
   * the wire (published by any client) so a continuation never re-publishes
   * them.
   * @param event - The classified transport event.
   */
  private _indexEvent(event: AdapterEvent<TMetadata, TDataParts, TTools>): void {
    if (event.kind !== 'message') return;
    // Skip the optimistic local echo of this client's own publishes (no serial
    // yet); the send paths index their own publishes from the publish result,
    // and the wire echo carries the same identity.
    if (event.meta.serial === undefined) return;
    const { codecMessageId, runId, role } = event.meta;
    if (codecMessageId !== undefined) {
      // The domain id: an output stream's `start` chunk carries it; a message
      // input carries it on its body. Fall back to the codec-message-id — the
      // id the provider reducer assigns when no start named one.
      let domainId: string | undefined;
      for (const output of event.outputs) {
        if (output.type !== 'start') continue;
        // Structural read: the generic chunk union does not narrow by `type`,
        // but only the start chunk carries `messageId`.
        const startId = 'messageId' in output && typeof output.messageId === 'string' ? output.messageId : undefined;
        domainId = startId ?? codecMessageId;
      }
      for (const input of event.inputs) {
        if (input.kind === 'message') domainId = input.payload.id;
      }
      if (domainId !== undefined) {
        const identity = { codecMessageId, runId };
        this._wireIdentityByMessageId.set(domainId, identity);
        if (role === 'assistant') this._newestAssistant = identity;
      } else if (role === 'assistant' && runId !== undefined) {
        // An assistant event with no start in this wire (a mid-stream append):
        // keep the newest-assistant cursor fresh without a domain id.
        this._newestAssistant = { codecMessageId, runId };
      }
    }
    for (const input of event.inputs) {
      if (input.kind === 'chunk' || input.kind === 'approval') {
        this._publishedToolCallIds.add(input.payload.toolCallId);
      }
    }
    // A resolution can also reach the wire as agent output (a
    // provider-executed tool, or the agent republishing a resolution): count
    // those too, so a continuation never re-publishes them. Structural read —
    // the generic chunk union does not narrow by `type`.
    for (const output of event.outputs) {
      if (output.type.startsWith('tool-output-') && 'toolCallId' in output && typeof output.toolCallId === 'string') {
        this._publishedToolCallIds.add(output.toolCallId);
      }
    }
  }

  /**
   * Open a chunk stream for one run. Live events are buffered until
   * `setRunId` names the run, then the buffer is replayed and events are
   * filtered by run-id: `message` events enqueue their output chunks; the
   * run's `end` or `suspend` lifecycle event closes the stream. An abort
   * cancels the run over the channel; the stream still closes via the run's
   * own end event.
   * @param abortSignal - useChat's per-send abort signal.
   * @returns The collector.
   */
  private _openRunStream(abortSignal?: AbortSignal): {
    stream: ReadableStream<AI.UIMessageChunk>;
    setRunId: (id: string, replay?: AdapterEvent<TMetadata, TDataParts, TTools>[]) => void;
    dispose: () => void;
  } {
    let runId: string | undefined;
    let closed = false;
    // Read through a call so control-flow narrowing does not assume `closed`
    // is still false after `deliver` (which can close via `finish`).
    const isClosed = (): boolean => closed;
    const buffered: AdapterEvent<TMetadata, TDataParts, TTools>[] = [];
    let controller: ReadableStreamDefaultController<AI.UIMessageChunk> | undefined;

    this._openStreams++;
    if (this._openStreams === 1) this._emitter.emit('streaming', true);

    const finish = (): void => {
      if (closed) return;
      closed = true;
      this._collectors.delete(handleEvent);
      this._streamFailers.delete(failStream);
      this._openStreams--;
      if (this._openStreams === 0) this._emitter.emit('streaming', false);
    };

    const deliver = (event: AdapterEvent<TMetadata, TDataParts, TTools>, id: string): void => {
      if (event.kind === 'message') {
        if (event.meta.runId !== id) return;
        for (const chunk of event.outputs) controller?.enqueue(chunk);
        return;
      }
      if (event.kind !== 'run-lifecycle' || event.event.runId !== id) return;
      if (event.event.type === 'end' || event.event.type === 'suspend') {
        finish();
        controller?.close();
      }
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

    abortSignal?.addEventListener('abort', () => {
      // Fire-and-forget: the cancel publish's failure is unrecoverable here,
      // and the stream still closes on the run's end event.
      if (runId !== undefined) void this._transport.cancel(runId).catch(swallowCancelFailure);
    });

    return {
      stream: new ReadableStream<AI.UIMessageChunk>({
        start(streamController) {
          controller = streamController;
        },
        cancel() {
          finish();
        },
      }),
      setRunId: (id: string, replay?: AdapterEvent<TMetadata, TDataParts, TTools>[]): void => {
        if (closed) return;
        runId = id;
        if (abortSignal?.aborted) {
          void this._transport.cancel(id).catch(swallowCancelFailure);
        }
        // Replay events (older than anything buffered live) first, then the
        // collector's own buffer, keeping delivery chronological throughout.
        for (const event of replay ?? []) {
          if (isClosed()) break;
          deliver(event, id);
        }
        for (const event of buffered) {
          if (isClosed()) break;
          deliver(event, id);
        }
        buffered.length = 0;
      },
      dispose: (): void => {
        finish();
      },
    };
  }

  /**
   * POST the invocation pointer to the chat route and return the run it
   * opened.
   * @param body - The invocation pointer.
   * @param body.eventId - The published input's event id, which the agent locates.
   * @param body.runId - The run to resume, for a continuation.
   * @returns The chat route's response body.
   */
  private async _postChat(body: { eventId: string; runId?: string }): Promise<ChatResponseBody> {
    if (this._closed) throw new Error('unable to send; the chat transport is closed');
    const response = await fetch(this._api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelName: this._channelName, ...body }),
    });
    if (!response.ok) {
      throw new Error(`chat request failed with status ${String(response.status)}`);
    }
    // CAST: trust boundary — the response body is the caller's own chat route's JSON.
    return (await response.json()) as ChatResponseBody;
  }
}

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
