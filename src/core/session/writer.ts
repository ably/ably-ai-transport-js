import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { Headers, WireMessages } from '../../headers.js';
import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecMessage, CodecPart } from '../codec/index.js';
import type { RunEndStatus } from '../run/index.js';
import type { ChannelManager } from './channel-manager.js';

/**
 * Options for {@link SessionWriter.sendMessages}. Subset of the RFC
 * interface — `parentId` (forks) lands in a later phase.
 */
export interface SendMessagesOptions<TMessage> {
  /**
   * The domain message or messages to encode and publish. Each message
   * gets its own `x-ably-msg-id`; all wire messages produced by the batch
   * are published in a single `channel.publish(...)` call.
   */
  messages: TMessage | TMessage[];
  /**
   * The run these messages belong to. Required, matching the RFC. Callers
   * obtaining a runId from `view.send` (phase 6) or `writer.startRun`
   * (deferred) pass it through here on follow-up sends.
   */
  runId: string;
  /**
   * Override the attribution clientId sent as `x-ably-client-id`. Use this
   * in backend publishers that forward user input on behalf of an end-user
   * (server-side input validation). When omitted, the publishing
   * connection's clientId is used.
   */
  clientId?: string;
}

/**
 * Options for {@link SessionWriter.endRun}. Phase 5 subset of the RFC
 * interface — `status` is restricted to `RunEndStatus` (currently only
 * `'complete'`); `'failed'` and `'aborted'` join the union additively in
 * later phases.
 */
export interface EndRunOptions {
  /** The run to end. */
  runId: string;
  /** Terminal status to record on `x-ably-run-end`. */
  status: RunEndStatus;
}

/**
 * The low-level write surface shared by both session types. Phase 5
 * exposes `sendMessages` and `endRun`; later phases add `sendParts`,
 * `sendEvents`, the rest of run/step lifecycle, and control-signal
 * methods additively.
 *
 * Parameterised by the session's codec so callers name the variant with a
 * single type argument.
 */
export interface SessionWriter<C extends AnyCodec> {
  /**
   * Publish one or more complete domain messages to the channel. The codec
   * encodes each message into its wire form via `Encoder.encodePart`; the
   * SDK decorates every wire message with `x-ably-msg-id`, `x-ably-role`,
   * `x-ably-run-id`, and (when supplied) `x-ably-client-id`. Multiple
   * messages each carry their own `x-ably-msg-id`; all wire messages
   * produced by the batch are published in a single `channel.publish(...)`
   * call.
   *
   * Resolves once Ably has acknowledged the publish.
   * @param options Per-call wiring; see {@link SendMessagesOptions}.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.SessionClosed}
   *   when called after the session has been closed.
   */
  sendMessages(options: SendMessagesOptions<CodecMessage<C>>): Promise<void>;

  /**
   * Publish `x-ably-run-end` to the channel, recording the run's terminal
   * status. The wire message carries `x-ably-run-id` and `x-ably-status`
   * headers; receivers route it to the tree to advance the matching run.
   *
   * Phase 5 only accepts status `'complete'` — `'aborted'` and `'failed'`
   * land alongside the agent surfaces that produce them. Resolves once
   * Ably has acknowledged the publish.
   * @param options Per-call wiring; see {@link EndRunOptions}.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.SessionClosed}
   *   when called after the session has been closed.
   */
  endRun(options: EndRunOptions): Promise<void>;
}

/** Options for constructing a {@link DefaultSessionWriter}. */
export interface SessionWriterOptions<C extends AnyCodec> {
  /** Codec instance used to encode published messages. */
  codec: C;
  /**
   * Channel manager owning the session's underlying channel. The writer
   * acquires the channel via {@link ChannelManager.get}; the manager's own
   * `isResolved` state is what `Session.close` reads to decide whether
   * teardown is required.
   */
  channelManager: ChannelManager;
  /**
   * Realtime client backing the session. The writer reads
   * `realtime.auth.clientId` to attribute the initiator of a run opened via
   * {@link DefaultSessionWriter.startRunWithMessages}; everything else flows
   * through {@link channelManager}.
   */
  realtime: Ably.Realtime;
  /**
   * Protocol-level role written to `x-ably-role`. ClientSession publishes
   * as `'user'`, AgentSession publishes as `'assistant'`.
   */
  role: 'user' | 'assistant';
  /** Logger inherited from the owning session. */
  logger: Logger;
  /** Reports whether the owning session has been closed. */
  isClosed: () => boolean;
}

/**
 * Generate a fresh transport-level message ID. Used until the codec layer
 * gains a way to surface caller-supplied IDs — at which point this becomes
 * a fallback for codecs whose messages have no intrinsic id.
 * @returns A random message ID.
 */
const generateMessageId = (): string => crypto.randomUUID();

/**
 * Default {@link SessionWriter} implementation backing
 * `ClientSession.writer`. Phase 3 only owns the `sendMessages` path;
 * later phases extend this class with additional lifecycle and control
 * publish methods.
 * @internal
 */
export class DefaultSessionWriter<C extends AnyCodec> implements SessionWriter<C> {
  private readonly _codec: C;
  private readonly _channelManager: ChannelManager;
  private readonly _realtime: Ably.Realtime;
  private readonly _role: 'user' | 'assistant';
  private readonly _logger: Logger;
  private readonly _isClosed: () => boolean;

  constructor(options: SessionWriterOptions<C>) {
    this._codec = options.codec;
    this._channelManager = options.channelManager;
    this._realtime = options.realtime;
    this._role = options.role;
    this._logger = options.logger.withContext({ component: 'SessionWriter' });
    this._isClosed = options.isClosed;
  }

  async sendMessages(options: SendMessagesOptions<CodecMessage<C>>): Promise<void> {
    this._logger.trace('DefaultSessionWriter.sendMessages();', { runId: options.runId });

    if (this._isClosed()) {
      throw new Ably.ErrorInfo('unable to send messages; session is closed', ErrorCode.SessionClosed, 400);
    }

    const messageArray = Array.isArray(options.messages) ? options.messages : [options.messages];
    if (messageArray.length === 0) {
      this._logger.debug('DefaultSessionWriter.sendMessages(); empty messages array — nothing to publish');
      return;
    }

    const { decorated } = this._encodeMessageBatch(messageArray, options);

    if (decorated.length === 0) {
      this._logger.debug('DefaultSessionWriter.sendMessages(); encoder produced no wire messages');
      return;
    }

    const channel = this._channelManager.get();
    await channel.publish(decorated);

    this._logger.debug('DefaultSessionWriter.sendMessages(); published', {
      runId: options.runId,
      messageCount: messageArray.length,
      wireCount: decorated.length,
    });
  }

  /**
   * Open a new run and publish its first message(s) in a single atomic batch.
   * Internal — not on the {@link SessionWriter} interface; the public
   * {@link ClientView.send} drives this. Phase 6 keeps `writer.startRun`
   * non-public because no caller outside the view needs to drive run-start
   * separately.
   *
   * Generates the runId, encodes each message via the codec with its own
   * `x-ably-msg-id`, decorates every wire message with the SDK headers,
   * prepends an `x-ably-run-start` carrying `x-ably-run-id`, and publishes
   * the whole batch in one `channel.publish(...)` call so the run lands
   * fully live with its first messages or not at all.
   * @param options The messages to publish onto the new run.
   * @param options.messages One or more domain messages to encode and publish.
   * @returns The generated runId, the message id of the **last** message in
   *   the batch (used as the precondition messageId for `run.toInvocation()`),
   *   and the resolved initiator clientId.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.SessionClosed}
   *   when called after the session has been closed.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.InvalidArgument}
   *   when the realtime connection has no concrete `clientId` — run
   *   attribution requires one and wildcard auth (`'*'`) cannot open a run —
   *   when the supplied messages array is empty, or when the codec produces
   *   no wire messages for the supplied input (which would land a hollow run).
   */
  async startRunWithMessages(options: { messages: CodecMessage<C> | CodecMessage<C>[] }): Promise<{
    runId: string;
    lastMessageId: string;
    initiatorClientId: string;
  }> {
    this._logger.trace('DefaultSessionWriter.startRunWithMessages();');

    if (this._isClosed()) {
      throw new Ably.ErrorInfo('unable to start run; session is closed', ErrorCode.SessionClosed, 400);
    }

    const initiatorClientId = this._realtime.auth.clientId;
    if (initiatorClientId.length === 0 || initiatorClientId === '*') {
      throw new Ably.ErrorInfo(
        'unable to start run; realtime connection has no concrete clientId',
        ErrorCode.InvalidArgument,
        400,
      );
    }

    const messageArray = Array.isArray(options.messages) ? options.messages : [options.messages];
    if (messageArray.length === 0) {
      throw new Ably.ErrorInfo(
        'unable to start run; messages must be a non-empty array',
        ErrorCode.InvalidArgument,
        400,
      );
    }

    const runId = generateMessageId();
    const decorateOptions: SendMessagesOptions<CodecMessage<C>> = { messages: messageArray, runId };
    const { decorated, lastMessageId } = this._encodeMessageBatch(messageArray, decorateOptions);

    if (decorated.length === 0 || lastMessageId === undefined) {
      // The plan requires `view.send` to publish [runStart, ...messages] atomically;
      // a codec that produces no wires would land a hollow run with no first
      // message. Reject loudly rather than violate that contract.
      throw new Ably.ErrorInfo(
        'unable to start run; encoder produced no wire messages for the supplied messages',
        ErrorCode.InvalidArgument,
        400,
      );
    }

    const runStartMessage: Ably.Message = {
      name: WireMessages.RunStart,
      extras: {
        headers: { [Headers.RunId]: runId },
      },
    };

    const channel = this._channelManager.get();
    await channel.publish([runStartMessage, ...decorated]);

    this._logger.debug('DefaultSessionWriter.startRunWithMessages(); published', {
      runId,
      messageCount: messageArray.length,
      wireCount: decorated.length + 1,
    });

    return { runId, lastMessageId, initiatorClientId };
  }

  async endRun(options: EndRunOptions): Promise<void> {
    this._logger.trace('DefaultSessionWriter.endRun();', { runId: options.runId, status: options.status });

    if (this._isClosed()) {
      throw new Ably.ErrorInfo('unable to end run; session is closed', ErrorCode.SessionClosed, 400);
    }

    const channel = this._channelManager.get();
    await channel.publish({
      name: WireMessages.RunEnd,
      extras: {
        headers: {
          [Headers.RunId]: options.runId,
          [Headers.Status]: options.status,
        },
      },
    });

    this._logger.debug('DefaultSessionWriter.endRun(); published', {
      runId: options.runId,
      status: options.status,
    });
  }

  /**
   * Encode a list of complete domain messages into decorated wire messages,
   * sharing one encoder across the batch. Each message gets its own
   * `x-ably-msg-id`; the encoder's closing wires (typically empty for codecs
   * that don't carry per-batch closure state) are attributed to the **last**
   * message's id so the toInvocation "last message" precondition aligns with
   * what's actually on the wire.
   * @param messages One or more domain messages.
   * @param options Decoration parameters (runId, optional clientId override) —
   *   `options.messages` is ignored; the batch is iterated explicitly.
   * @returns The decorated wire messages and the last message id (or
   *   `undefined` when `messages` is empty).
   */
  private _encodeMessageBatch(
    messages: CodecMessage<C>[],
    options: SendMessagesOptions<CodecMessage<C>>,
  ): { decorated: Ably.Message[]; lastMessageId: string | undefined } {
    const encoder = this._codec.createEncoder();
    const decorated: Ably.Message[] = [];
    let lastMessageId: string | undefined;
    for (const message of messages) {
      const messageId = generateMessageId();
      lastMessageId = messageId;
      // CAST: writer reuses encodePart per the plan. The stub codec and codecs
      // whose `TMessage` is a single `TPart` (i.e. messages that are themselves
      // parts on the wire) round-trip cleanly. Real-codec multi-part encoding
      // lands in phase 8.
      const partWireMessages = encoder.encodePart(message as unknown as CodecPart<C>);
      for (const wire of partWireMessages) {
        decorated.push(this._decorate(wire, messageId, options));
      }
    }
    const finalWireMessages = encoder.close();
    if (lastMessageId !== undefined) {
      for (const wire of finalWireMessages) {
        decorated.push(this._decorate(wire, lastMessageId, options));
      }
    }
    return { decorated, lastMessageId };
  }

  private _decorate(
    wireMessage: Ably.Message,
    messageId: string,
    options: SendMessagesOptions<CodecMessage<C>>,
  ): Ably.Message {
    // CAST: Ably types `extras` as `any`; narrow to the headers shape we own.
    const existingExtras = wireMessage.extras as { headers?: Record<string, string> } | undefined;
    const headers: Record<string, string> = {
      ...existingExtras?.headers,
      [Headers.MessageId]: messageId,
      [Headers.Role]: this._role,
      [Headers.RunId]: options.runId,
    };
    if (options.clientId !== undefined) {
      headers[Headers.ClientId] = options.clientId;
    }
    return {
      ...wireMessage,
      extras: {
        ...existingExtras,
        headers,
      },
    };
  }
}
