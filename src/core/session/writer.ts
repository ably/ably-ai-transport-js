import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { Headers, WireMessages } from '../../headers.js';
import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecEvent, CodecMessage, CodecPart, Encoder } from '../codec/index.js';
import { createEncoderCore } from '../codec/index.js';
import type { RunEndStatus } from '../run/index.js';
import type { StepEndStatus } from '../step/index.js';
import type { ChannelManager } from './channel-manager.js';

/**
 * Options for {@link SessionWriter.sendMessages}. Subset of the RFC
 * interface — `parentId` (forks) lands in a later phase.
 */
export interface SendMessagesOptions<TMessage> {
  /**
   * The domain message or messages to encode and publish. Each message
   * gets its own `x-ably-msg-id` and is published independently — the
   * encoder drives one publish (or batch of related wires, codec's
   * choice) per message rather than bundling them into a single atomic
   * `channel.publish(...)`.
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
   * encodes each message via `Encoder.encodeMessage`, which drives I/O
   * through an `EncoderCore` bound to the session's channel. The SDK
   * stamps every emitted wire with `x-ably-msg-id` (one fresh routing id
   * per message), `x-ably-role`, `x-ably-run-id`, and — when supplied —
   * `x-ably-client-id`. Each message gets its own `channel.publish(...)`
   * call; messages are not bundled into a single atomic batch.
   *
   * Resolves once every emitted wire is acknowledged by Ably.
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
 * Generate a fresh transport-level message ID. The SDK always assigns its
 * own routing id on every outbound wire — codecs that need to round-trip a
 * caller-supplied domain id (e.g. `UIMessage.id`) carry it inside the wire
 * via their own `x-domain-*` header rather than reusing this routing id.
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

    const { lastMessageId } = await this._encodeMessageBatch(messageArray, options);

    this._logger.debug('DefaultSessionWriter.sendMessages(); published', {
      runId: options.runId,
      messageCount: messageArray.length,
      lastMessageId,
    });
  }

  /**
   * Open a new run and publish its first message(s) sequentially. Internal
   * — not on the {@link SessionWriter} interface; the public
   * {@link ClientView.send} drives this.
   *
   * Generates the runId, publishes `x-ably-run-start` first and awaits the
   * ack, then drives the codec encoder to publish the first message(s).
   * The run-start and the first content message are **not atomic** on the
   * wire: if the run-start publish fails, nothing is on the channel and
   * the call rejects cleanly. If the message publish fails, the run is
   * open with no first message — the call rejects and the caller is
   * responsible for retry. The simplification keeps the codec layer free
   * of buffer abstractions.
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
   *   or when the supplied messages array is empty.
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
    const channel = this._channelManager.get();

    // 1. Publish run-start. If this fails, no content has gone out — clean retry.
    await channel.publish({
      name: WireMessages.RunStart,
      extras: { headers: { [Headers.RunId]: runId } },
    });

    // 2. Encode and publish the message(s). If this fails the run is open
    //    with no first message; the rejection surfaces to the caller, who
    //    is responsible for retry. Failure is observable, not silent.
    const sendOptions: SendMessagesOptions<CodecMessage<C>> = { messages: messageArray, runId };
    const { lastMessageId } = await this._encodeMessageBatch(messageArray, sendOptions);

    // Non-empty `messageArray` (checked above) always assigns `lastMessageId`
    // inside `_encodeMessageBatch`'s for-loop, so this assertion is a type
    // narrowing convenience for the caller — the success path always carries
    // an id.
    if (lastMessageId === undefined) {
      throw new Ably.ErrorInfo(
        'unable to start run; encoder produced no wire messages for the supplied messages',
        ErrorCode.InvalidArgument,
        400,
      );
    }

    this._logger.debug('DefaultSessionWriter.startRunWithMessages(); published', {
      runId,
      messageCount: messageArray.length,
    });

    return { runId, lastMessageId, initiatorClientId };
  }

  /**
   * Publish `x-ably-step-start` to the channel, opening a step within an
   * existing run. Internal — not on the {@link SessionWriter} interface;
   * the public {@link Step.start} drives this through {@link DefaultStep}.
   *
   * The wire carries {@link Headers.RunId} and {@link Headers.StepId}; the
   * step-end wire that closes the lifecycle lands in a later phase along
   * with the rest of the step write surface (`pipe`, `end`, `sendMessages`).
   * @param options Identifiers for the run and step to publish.
   * @param options.runId The run this step belongs to.
   * @param options.stepId The id of the step being opened.
   * @returns Resolves once Ably has acknowledged the publish.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.SessionClosed}
   *   when called after the session has been closed.
   */
  async startStep(options: { runId: string; stepId: string }): Promise<void> {
    this._logger.trace('DefaultSessionWriter.startStep();', { runId: options.runId, stepId: options.stepId });

    if (this._isClosed()) {
      throw new Ably.ErrorInfo('unable to start step; session is closed', ErrorCode.SessionClosed, 400);
    }

    const channel = this._channelManager.get();
    await channel.publish({
      name: WireMessages.StepStart,
      extras: {
        headers: {
          [Headers.RunId]: options.runId,
          [Headers.StepId]: options.stepId,
        },
      },
    });

    this._logger.debug('DefaultSessionWriter.startStep(); published', {
      runId: options.runId,
      stepId: options.stepId,
    });
  }

  /**
   * Publish `x-ably-step-end` to the channel, recording the terminal status
   * of an active step. Internal — not on the {@link SessionWriter}
   * interface; the public {@link Step.end} drives this through
   * {@link DefaultStep}.
   *
   * The wire carries {@link Headers.RunId}, {@link Headers.StepId}, and
   * {@link Headers.Status}.
   * @param options Identifiers for the run/step plus its terminal status.
   * @param options.runId The run the step belongs to.
   * @param options.stepId The id of the step being ended.
   * @param options.status The terminal status to record.
   * @returns Resolves once Ably has acknowledged the publish.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.SessionClosed}
   *   when called after the session has been closed.
   */
  async endStep(options: { runId: string; stepId: string; status: StepEndStatus }): Promise<void> {
    this._logger.trace('DefaultSessionWriter.endStep();', {
      runId: options.runId,
      stepId: options.stepId,
      status: options.status,
    });

    if (this._isClosed()) {
      throw new Ably.ErrorInfo('unable to end step; session is closed', ErrorCode.SessionClosed, 400);
    }

    const channel = this._channelManager.get();
    await channel.publish({
      name: WireMessages.StepEnd,
      extras: {
        headers: {
          [Headers.RunId]: options.runId,
          [Headers.StepId]: options.stepId,
          [Headers.Status]: options.status,
        },
      },
    });

    this._logger.debug('DefaultSessionWriter.endStep(); published', {
      runId: options.runId,
      stepId: options.stepId,
      status: options.status,
    });
  }

  /**
   * Build a fresh codec encoder bound to a new {@link EncoderCore} over the
   * session's channel. Internal — used by {@link DefaultStep} to drive
   * {@link Step.pipe}/{@link Step.end} through a long-lived encoder. The
   * caller owns the encoder's lifecycle and is responsible for calling
   * `close()` when finished.
   * @returns A fresh encoder ready for content publishes.
   */
  buildEncoder(): Encoder<CodecPart<C>, CodecMessage<C>, CodecEvent<C>> {
    const channel = this._channelManager.get();
    const core = createEncoderCore(channel, { logger: this._logger });
    // CAST: `this._codec` is constrained to `AnyCodec` (Codec<any, any, any>),
    // so `createEncoder` is typed as returning `Encoder<any, any, any>` at the
    // constraint layer. The cast narrows back to the precise `C`-bound
    // parameter triple — equivalent to the implicit narrowing TS performs at
    // the variable assignment in `_encodeMessageBatch`.
    return this._codec.createEncoder({ core, logger: this._logger }) as Encoder<
      CodecPart<C>,
      CodecMessage<C>,
      CodecEvent<C>
    >;
  }

  /**
   * The protocol-level role this writer attributes to outgoing content
   * wires (`'user'` for client sessions, `'assistant'` for agent
   * sessions). Internal — exposed so {@link DefaultStep.pipe} can stamp
   * the matching `x-ably-role` header on its piped content wires without
   * routing through the writer's `sendMessages`/`sendParts` paths.
   * @returns The protocol role — `'user'` or `'assistant'`.
   */
  get role(): 'user' | 'assistant' {
    return this._role;
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
   * Drive the codec encoder against the session's channel for a batch of
   * complete domain messages. Each call constructs a fresh
   * {@link import('../codec/index.js').EncoderCore} and codec encoder; the
   * encoder publishes through the core directly (no buffer or atomic-batch
   * glue). Each message gets its own writer-generated `x-ably-msg-id`;
   * caller-supplied domain ids round-trip via codec-owned `x-domain-*`
   * headers on the wire, not by reusing this routing id.
   * @param messages One or more domain messages.
   * @param options Per-call wiring (runId, optional clientId override).
   * @returns The id of the **last** message published, or `undefined` when
   *   `messages` is empty (the caller checks for empty up front).
   */
  private async _encodeMessageBatch(
    messages: CodecMessage<C>[],
    options: SendMessagesOptions<CodecMessage<C>>,
  ): Promise<{ lastMessageId: string | undefined }> {
    const channel = this._channelManager.get();
    const core = createEncoderCore(channel, { logger: this._logger });
    const encoder = this._codec.createEncoder({ core, logger: this._logger });

    let lastMessageId: string | undefined;
    try {
      for (const message of messages) {
        const messageId = generateMessageId();
        lastMessageId = messageId;

        const headers: Record<string, string> = {
          [Headers.MessageId]: messageId,
          [Headers.Role]: this._role,
          [Headers.RunId]: options.runId,
        };
        if (options.clientId !== undefined) {
          headers[Headers.ClientId] = options.clientId;
        }

        await encoder.encodeMessage(message, { headers });
      }
    } finally {
      await encoder.close();
    }

    return { lastMessageId };
  }
}
