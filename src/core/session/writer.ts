import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { Headers, WireMessages } from '../../headers.js';
import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecMessage, CodecPart } from '../codec/index.js';
import type { RunEndStatus } from '../run/index.js';
import type { ChannelManager } from './channel-manager.js';

/**
 * Options for {@link SessionWriter.sendMessages}. Phase 3 subset of the
 * RFC interface — `parentId` (forks) and the `messages: TMessage |
 * TMessage[]` array form land in later phases.
 */
export interface SendMessagesOptions<TMessage> {
  /**
   * The domain message to encode and publish. Phase 3 accepts a single
   * message; the array form widens additively in a later phase.
   */
  messages: TMessage;
  /**
   * The run this message belongs to. Required, matching the RFC. Until the
   * run lifecycle lands in phase 5 there is no public way to obtain a
   * runId from the SDK — callers supply their own.
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
   * Publish one complete domain message to the channel. The codec encodes
   * the message into its wire form via `Encoder.encodePart`; the SDK
   * decorates each wire message with `x-ably-msg-id`, `x-ably-role`,
   * `x-ably-run-id`, and (when supplied) `x-ably-client-id`.
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
  private readonly _role: 'user' | 'assistant';
  private readonly _logger: Logger;
  private readonly _isClosed: () => boolean;

  constructor(options: SessionWriterOptions<C>) {
    this._codec = options.codec;
    this._channelManager = options.channelManager;
    this._role = options.role;
    this._logger = options.logger.withContext({ component: 'SessionWriter' });
    this._isClosed = options.isClosed;
  }

  async sendMessages(options: SendMessagesOptions<CodecMessage<C>>): Promise<void> {
    this._logger.trace('DefaultSessionWriter.sendMessages();', { runId: options.runId });

    if (this._isClosed()) {
      throw new Ably.ErrorInfo('unable to send messages; session is closed', ErrorCode.SessionClosed, 400);
    }

    const messageId = generateMessageId();
    const encoder = this._codec.createEncoder();
    // CAST: phase 3's writer reuses encodePart per the plan. The stub codec
    // and codecs whose `TMessage` is a single `TPart` (i.e. messages that
    // are themselves parts on the wire) round-trip cleanly. Real-codec
    // multi-part encoding lands in phase 8.
    const partWireMessages = encoder.encodePart(options.messages as unknown as CodecPart<C>);
    const finalWireMessages = encoder.close();
    const wireMessages = [...partWireMessages, ...finalWireMessages];

    if (wireMessages.length === 0) {
      this._logger.debug('DefaultSessionWriter.sendMessages(); encoder produced no wire messages');
      return;
    }

    const decorated = wireMessages.map((wireMessage) => this._decorate(wireMessage, messageId, options));

    const channel = this._channelManager.get();
    await channel.publish(decorated);

    this._logger.debug('DefaultSessionWriter.sendMessages(); published', {
      runId: options.runId,
      messageId,
      count: decorated.length,
    });
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
