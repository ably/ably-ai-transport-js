/**
 * Vercel AI SDK encoder.
 *
 * Single public `publish(event, options?)` method that maps each VercelEvent
 * to one or more channel operations. The codec inspects the event's
 * discriminator and routes to `EncoderCore.startStream` / `appendStream` /
 * `closeStream` / `publishDiscrete` / `publishDiscreteBatch`. Stream-tracker
 * state lives inside the encoder core; callers don't see it.
 *
 * Domain-specific headers use the `x-domain-` prefix to distinguish them
 * from transport-level `x-ably-` headers.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { isDataUIPart } from 'ai';

import { HEADER_ROLE, HEADER_STATUS } from '../../constants.js';
import type { EncoderCore, EncoderCoreOptions } from '../../core/codec/encoder.js';
import { createEncoderCore } from '../../core/codec/encoder.js';
import type { ChannelWriter, Encoder, MessagePayload, WriteOptions } from '../../core/codec/types.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import { headerWriter } from '../../utils.js';
import type {
  ClientToolOutputErrorEvent,
  ClientToolOutputEvent,
  ToolApprovalEvent,
  UserMessageEvent,
  VercelEvent,
} from './events.js';

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultUIMessageEncoder implements Encoder<VercelEvent> {
  private readonly _core: EncoderCore;
  private readonly _messageId: string | undefined;
  private _aborted = false;

  constructor(writer: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._core = createEncoderCore(writer, options);
    this._messageId = options.messageId;
  }

  async publish(event: VercelEvent, options?: WriteOptions): Promise<void> {
    if (event.type === 'ait-user-message') {
      await this._publishUserMessage(event, options);
      return;
    }
    if (event.type === 'ait-tool-approval') {
      await this._publishToolApproval(event, options);
      return;
    }
    if (event.type === 'ait-client-tool-output') {
      await this._publishClientToolOutput(event, options);
      return;
    }
    if (event.type === 'ait-client-tool-output-error') {
      await this._publishClientToolOutputError(event, options);
      return;
    }
    await this._publishChunk(event, options);
  }

  async abort(reason?: string): Promise<void> {
    if (this._aborted) return;
    this._aborted = true;
    await this._core.abortAllStreams();
    await this._core.publishDiscrete({
      name: 'abort',
      data: reason ?? '',
      headers: { [HEADER_STATUS]: 'aborted' },
    });
  }

  async close(): Promise<void> {
    await this._core.close();
  }

  // -------------------------------------------------------------------------
  // VercelEvent routing — UIMessageChunk
  // -------------------------------------------------------------------------

  private async _publishChunk(chunk: AI.UIMessageChunk, perWrite?: WriteOptions): Promise<void> {
    switch (chunk.type) {
      // -- Stream start -----------------------------------------------------
      case 'text-start': {
        const h = headerWriter().str('id', chunk.id).json('providerMetadata', chunk.providerMetadata).build();
        await this._core.startStream(chunk.id, { name: 'text', data: '', headers: h }, perWrite);
        return;
      }
      case 'reasoning-start': {
        const h = headerWriter().str('id', chunk.id).json('providerMetadata', chunk.providerMetadata).build();
        await this._core.startStream(chunk.id, { name: 'reasoning', data: '', headers: h }, perWrite);
        return;
      }
      case 'tool-input-start': {
        const h = headerWriter()
          .str('toolCallId', chunk.toolCallId)
          .str('toolName', chunk.toolName)
          .bool('dynamic', chunk.dynamic)
          .str('title', chunk.title)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.startStream(chunk.toolCallId, { name: 'tool-input', data: '', headers: h }, perWrite);
        return;
      }

      // -- Stream append ----------------------------------------------------
      case 'text-delta': {
        this._core.appendStream(chunk.id, chunk.delta);
        return;
      }
      case 'reasoning-delta': {
        this._core.appendStream(chunk.id, chunk.delta);
        return;
      }
      case 'tool-input-delta': {
        this._core.appendStream(chunk.toolCallId, chunk.inputTextDelta);
        return;
      }

      // -- Stream close -----------------------------------------------------
      case 'text-end': {
        const h = headerWriter().str('id', chunk.id).json('providerMetadata', chunk.providerMetadata).build();
        await this._core.closeStream(chunk.id, { name: 'text', data: '', headers: h });
        return;
      }
      case 'reasoning-end': {
        const h = headerWriter().str('id', chunk.id).json('providerMetadata', chunk.providerMetadata).build();
        await this._core.closeStream(chunk.id, { name: 'reasoning', data: '', headers: h });
        return;
      }
      case 'tool-input-available': {
        try {
          const h = headerWriter()
            .str('toolCallId', chunk.toolCallId)
            .str('toolName', chunk.toolName)
            .json('providerMetadata', chunk.providerMetadata)
            .build();
          await this._core.closeStream(chunk.toolCallId, { name: 'tool-input', data: '', headers: h });
        } catch (error: unknown) {
          // Only fall through to discrete for "no active stream" — rethrow real failures.
          if (!(error instanceof Ably.ErrorInfo && errorInfoIs(error, ErrorCode.InvalidArgument))) {
            throw error;
          }
          const h = headerWriter()
            .str('toolCallId', chunk.toolCallId)
            .str('toolName', chunk.toolName)
            .bool('dynamic', chunk.dynamic)
            .str('title', chunk.title)
            .bool('providerExecuted', chunk.providerExecuted)
            .json('providerMetadata', chunk.providerMetadata)
            .build();
          await this._core.publishDiscrete({ name: 'tool-input', data: chunk.input, headers: h });
        }
        return;
      }

      // -- Lifecycle (discrete) ---------------------------------------------
      case 'start': {
        const h = headerWriter()
          .str('messageId', chunk.messageId ?? this._messageId)
          .json('messageMetadata', chunk.messageMetadata)
          .build();
        await this._core.publishDiscrete({ name: 'start', data: '', headers: h }, perWrite);
        return;
      }
      case 'start-step': {
        await this._core.publishDiscrete({ name: 'start-step', data: '' }, perWrite);
        return;
      }
      case 'finish-step': {
        await this._core.publishDiscrete({ name: 'finish-step', data: '' }, perWrite);
        return;
      }
      case 'finish': {
        const h = headerWriter()
          .str('finishReason', chunk.finishReason)
          .json('messageMetadata', chunk.messageMetadata)
          .build();
        await this._core.publishDiscrete({ name: 'finish', data: '', headers: h }, perWrite);
        return;
      }
      case 'error': {
        await this._core.publishDiscrete({ name: 'error', data: chunk.errorText }, perWrite);
        return;
      }
      case 'abort': {
        this._aborted = true;
        await this._core.abortAllStreams(perWrite);
        await this._core.publishDiscrete(
          { name: 'abort', data: chunk.reason ?? '', headers: { [HEADER_STATUS]: 'aborted' } },
          perWrite,
        );
        return;
      }
      case 'message-metadata': {
        const h = headerWriter().json('messageMetadata', chunk.messageMetadata).build();
        await this._core.publishDiscrete({ name: 'message-metadata', data: '', headers: h }, perWrite);
        return;
      }

      // -- Tool lifecycle (discrete) ----------------------------------------
      case 'tool-input-error': {
        const h = headerWriter()
          .str('toolCallId', chunk.toolCallId)
          .str('toolName', chunk.toolName)
          .bool('dynamic', chunk.dynamic)
          .str('title', chunk.title)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete(
          { name: 'tool-input-error', data: { errorText: chunk.errorText, input: chunk.input }, headers: h },
          perWrite,
        );
        return;
      }
      case 'tool-output-available':
      case 'tool-output-error':
      case 'tool-approval-request':
      case 'tool-output-denied': {
        await this._core.publishDiscrete(buildToolOutputPayload(chunk), perWrite);
        return;
      }

      // -- Content parts (discrete) -----------------------------------------
      case 'file': {
        const h = headerWriter()
          .str('mediaType', chunk.mediaType)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({ name: 'file', data: chunk.url, headers: h }, perWrite);
        return;
      }
      case 'source-url': {
        const h = headerWriter()
          .str('sourceId', chunk.sourceId)
          .str('title', chunk.title)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({ name: 'source-url', data: chunk.url, headers: h }, perWrite);
        return;
      }
      case 'source-document': {
        const h = headerWriter()
          .str('sourceId', chunk.sourceId)
          .str('mediaType', chunk.mediaType)
          .str('title', chunk.title)
          .str('filename', chunk.filename)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({ name: 'source-document', data: '', headers: h }, perWrite);
        return;
      }

      // -- data-* (discrete) ------------------------------------------------
      default: {
        if (chunk.type.startsWith('data-')) {
          // CAST: data-* chunks always have id, transient, and data fields per AI SDK types.
          // TypeScript can't narrow the template literal union in a default case.
          const dataChunk = chunk;
          const h = headerWriter().str('id', dataChunk.id).bool('transient', dataChunk.transient).build();
          const ephemeral = dataChunk.transient === true;
          await this._core.publishDiscrete({ name: chunk.type, data: dataChunk.data, headers: h, ephemeral }, perWrite);
          return;
        }
        throw new Ably.ErrorInfo(
          `unable to publish event; unsupported chunk type '${chunk.type}'`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // VercelEvent routing — codec-local
  // -------------------------------------------------------------------------

  /**
   * Publish a user message as a batch of per-part discrete Ably messages.
   * Wire format matches today's `writeMessages` output for compatibility
   * with existing channel history.
   * @param event - The user-message TEvent carrying the UIMessage to encode.
   * @param perWrite - Optional per-write overrides (clientId, extras, messageId).
   */
  private async _publishUserMessage(event: UserMessageEvent, perWrite?: WriteOptions): Promise<void> {
    const payloads = encodeMessagePayloads(event.message);
    const headers = payloads.length > 0 ? { ...payloads[0]?.headers, [HEADER_ROLE]: 'user' } : {};
    // Stamp role on every payload so the decoder can reconstruct a `role: 'user'` UIMessage.
    for (const payload of payloads) {
      payload.headers = { ...payload.headers, [HEADER_ROLE]: 'user' };
    }
    void headers;
    await this._core.publishDiscreteBatch(payloads, perWrite);
  }

  /**
   * Publish a tool approval response as a discrete `tool-approval-response`
   * Ably message. The wire message stamps `HEADER_MSG_ID =
   * event.targetMsgId` so the reducer folds the response onto the original
   * assistant message via its normal per-message-id routing.
   * @param event - The tool-approval TEvent (toolCallId, approved, optional reason, targetMsgId).
   * @param perWrite - Optional per-write overrides (clientId, extras, messageId).
   */
  private async _publishToolApproval(event: ToolApprovalEvent, perWrite?: WriteOptions): Promise<void> {
    const h = headerWriter()
      .str('toolCallId', event.toolCallId)
      .bool('approved', event.approved)
      .str('reason', event.reason)
      .build();
    await this._core.publishDiscrete(
      { name: 'tool-approval-response', data: '', headers: h },
      _withTarget(perWrite, event.targetMsgId),
    );
  }

  /**
   * Publish a client-executed tool's output as a discrete
   * `tool-output-available` Ably message — the same wire shape the agent
   * uses for its own streamText tool outputs. The wire message stamps
   * `HEADER_MSG_ID = event.targetMsgId` so the reducer folds the output
   * onto the suspended assistant message.
   * @param event - The client-tool-output TEvent (toolCallId, output, targetMsgId).
   * @param perWrite - Optional per-write overrides (clientId, extras, messageId).
   */
  private async _publishClientToolOutput(event: ClientToolOutputEvent, perWrite?: WriteOptions): Promise<void> {
    const h = headerWriter().str('toolCallId', event.toolCallId).build();
    await this._core.publishDiscrete(
      { name: 'tool-output-available', data: { output: event.output }, headers: h },
      _withTarget(perWrite, event.targetMsgId),
    );
  }

  /**
   * Publish a client-executed tool's failure as a discrete `tool-output-error`
   * Ably message. Symmetric to {@link _publishClientToolOutput}: the wire
   * message stamps `HEADER_MSG_ID = event.targetMsgId` so the reducer folds
   * the error onto the suspended assistant message's dynamic-tool part.
   * @param event - The client-tool-output-error TEvent (toolCallId, errorText, targetMsgId).
   * @param perWrite - Optional per-write overrides (clientId, extras, messageId).
   */
  private async _publishClientToolOutputError(
    event: ClientToolOutputErrorEvent,
    perWrite?: WriteOptions,
  ): Promise<void> {
    const h = headerWriter().str('toolCallId', event.toolCallId).build();
    await this._core.publishDiscrete(
      { name: 'tool-output-error', data: { errorText: event.errorText }, headers: h },
      _withTarget(perWrite, event.targetMsgId),
    );
  }
}

/**
 * Stamp `messageId = targetMsgId` into a `WriteOptions`, preserving
 * caller-supplied fields. The encoder-core writes `messageId` as
 * `HEADER_MSG_ID`; the reducer routes events by that header to the
 * target message in the projection. Used by the codec's publishers for
 * events that modify a previously-published message.
 * @param perWrite - The caller's per-write options (may be undefined).
 * @param targetMsgId - The msg-id of the message this event modifies.
 * @returns A new `WriteOptions` with the target stamped as `messageId`.
 */
const _withTarget = (perWrite: WriteOptions | undefined, targetMsgId: string): WriteOptions => ({
  ...perWrite,
  messageId: targetMsgId,
  extras: { ...perWrite?.extras },
});

// ---------------------------------------------------------------------------
// Tool output discrete payload builder
// ---------------------------------------------------------------------------

const buildToolOutputPayload = (
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'tool-output-available' | 'tool-output-error' | 'tool-approval-request' | 'tool-output-denied' }
  >,
): MessagePayload => {
  switch (chunk.type) {
    case 'tool-output-available': {
      const h = headerWriter()
        .str('toolCallId', chunk.toolCallId)
        .bool('dynamic', chunk.dynamic)
        .bool('providerExecuted', chunk.providerExecuted)
        .bool('preliminary', chunk.preliminary)
        .build();
      return { name: 'tool-output-available', data: { output: chunk.output }, headers: h };
    }
    case 'tool-output-error': {
      const h = headerWriter()
        .str('toolCallId', chunk.toolCallId)
        .bool('dynamic', chunk.dynamic)
        .bool('providerExecuted', chunk.providerExecuted)
        .build();
      return { name: 'tool-output-error', data: { errorText: chunk.errorText }, headers: h };
    }
    case 'tool-approval-request': {
      const h = headerWriter().str('toolCallId', chunk.toolCallId).str('approvalId', chunk.approvalId).build();
      return { name: 'tool-approval-request', data: '', headers: h };
    }
    case 'tool-output-denied': {
      const h = headerWriter().str('toolCallId', chunk.toolCallId).build();
      return { name: 'tool-output-denied', data: '', headers: h };
    }
  }
};

// ---------------------------------------------------------------------------
// User-message per-part payload encoding
// ---------------------------------------------------------------------------

const encodeMessagePayloads = (message: AI.UIMessage): MessagePayload[] => {
  const messageId = message.id;
  const payloads: MessagePayload[] = [];

  for (const part of message.parts) {
    switch (part.type) {
      case 'text': {
        payloads.push({ name: 'text', data: part.text, headers: headerWriter().str('messageId', messageId).build() });
        break;
      }
      case 'file': {
        payloads.push({
          name: 'file',
          data: part.url,
          headers: headerWriter().str('messageId', messageId).str('mediaType', part.mediaType).build(),
        });
        break;
      }
      default: {
        if (isDataUIPart(part)) {
          payloads.push({
            name: part.type,
            data: part.data,
            headers: headerWriter().str('messageId', messageId).str('id', part.id).build(),
          });
        }
        break;
      }
    }
  }

  if (payloads.length === 0) {
    payloads.push({ name: 'text', data: '', headers: headerWriter().str('messageId', messageId).build() });
  }

  return payloads;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel AI SDK encoder that maps VercelEvents to Ably channel
 * operations via the encoder core.
 * @param writer - The channel writer to publish messages through.
 * @param options - Encoder configuration (clientId, extras, hooks, logger).
 * @returns An {@link Encoder} for the Vercel TEvent union.
 */
export const createEncoder = (writer: ChannelWriter, options: EncoderCoreOptions = {}): Encoder<VercelEvent> =>
  new DefaultUIMessageEncoder(writer, options);
