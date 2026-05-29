/**
 * Vercel AI SDK encoder.
 *
 * Single public `publish(event, options?)` method that maps each VercelEvent
 * to one or more channel operations. The codec inspects the event's
 * discriminator and routes to `EncoderCore.startStream` / `appendStream` /
 * `closeStream` / `publishDiscrete` / `publishDiscreteBatch`. Stream-tracker
 * state lives inside the encoder core; callers don't see it.
 *
 * Every codec event published from a UIMessageChunk rides the single
 * `ai-output` wire name; the chunk's own `type` field is carried in the
 * `x-domain-type` domain header so the decoder can dispatch.
 *
 * Domain-specific headers use the `x-domain-` prefix to distinguish them
 * from transport-level `x-ably-` headers.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { isDataUIPart } from 'ai';

import { EVENT_AI_OUTPUT, HEADER_ROLE, HEADER_STATUS } from '../../constants.js';
import type { EncoderCore, EncoderCoreOptions } from '../../core/codec/encoder.js';
import { createEncoderCore } from '../../core/codec/encoder.js';
import type { ChannelWriter, Encoder, MessagePayload, WriteOptions } from '../../core/codec/types.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import { headerWriter } from '../../utils.js';
import type { RegenerateEvent, ToolApprovalResponseEvent, UserMessageEvent, VercelEvent } from './events.js';

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultUIMessageEncoder implements Encoder<VercelEvent> {
  private readonly _core: EncoderCore;
  private readonly _messageId: string | undefined;
  private _cancelled = false;

  constructor(writer: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._core = createEncoderCore(writer, options);
    this._messageId = options.messageId;
  }

  async publish(event: VercelEvent, options?: WriteOptions): Promise<void> {
    if (event.type === 'ait-user-message') {
      await this._publishUserMessage(event, options);
      return;
    }
    if (event.type === 'tool-approval-response') {
      await this._publishToolApprovalResponse(event, options);
      return;
    }
    if (event.type === 'ait-regenerate') {
      await this._publishRegenerate(event, options);
      return;
    }
    await this._publishChunk(event, options);
  }

  async cancel(reason?: string): Promise<void> {
    if (this._cancelled) return;
    this._cancelled = true;
    await this._core.cancelAllStreams();
    await this._core.publishDiscrete({
      name: EVENT_AI_OUTPUT,
      data: reason ?? '',
      headers: { ...headerWriter().str('type', 'abort').build(), [HEADER_STATUS]: 'cancelled' },
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
        const h = headerWriter()
          .str('type', 'text')
          .str('id', chunk.id)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.startStream(chunk.id, { name: EVENT_AI_OUTPUT, data: '', headers: h }, perWrite);
        return;
      }
      case 'reasoning-start': {
        const h = headerWriter()
          .str('type', 'reasoning')
          .str('id', chunk.id)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.startStream(chunk.id, { name: EVENT_AI_OUTPUT, data: '', headers: h }, perWrite);
        return;
      }
      case 'tool-input-start': {
        const h = headerWriter()
          .str('type', 'tool-input')
          .str('toolCallId', chunk.toolCallId)
          .str('toolName', chunk.toolName)
          .bool('dynamic', chunk.dynamic)
          .str('title', chunk.title)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.startStream(chunk.toolCallId, { name: EVENT_AI_OUTPUT, data: '', headers: h }, perWrite);
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
        const h = headerWriter()
          .str('type', 'text')
          .str('id', chunk.id)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.closeStream(chunk.id, { name: EVENT_AI_OUTPUT, data: '', headers: h });
        return;
      }
      case 'reasoning-end': {
        const h = headerWriter()
          .str('type', 'reasoning')
          .str('id', chunk.id)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.closeStream(chunk.id, { name: EVENT_AI_OUTPUT, data: '', headers: h });
        return;
      }
      case 'tool-input-available': {
        try {
          const h = headerWriter()
            .str('type', 'tool-input')
            .str('toolCallId', chunk.toolCallId)
            .str('toolName', chunk.toolName)
            .json('providerMetadata', chunk.providerMetadata)
            .build();
          await this._core.closeStream(chunk.toolCallId, { name: EVENT_AI_OUTPUT, data: '', headers: h });
        } catch (error: unknown) {
          // Only fall through to discrete for "no active stream" — rethrow real failures.
          if (!(error instanceof Ably.ErrorInfo && errorInfoIs(error, ErrorCode.InvalidArgument))) {
            throw error;
          }
          const h = headerWriter()
            .str('type', 'tool-input')
            .str('toolCallId', chunk.toolCallId)
            .str('toolName', chunk.toolName)
            .bool('dynamic', chunk.dynamic)
            .str('title', chunk.title)
            .bool('providerExecuted', chunk.providerExecuted)
            .json('providerMetadata', chunk.providerMetadata)
            .build();
          await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: chunk.input, headers: h });
        }
        return;
      }

      // -- Lifecycle (discrete) ---------------------------------------------
      case 'start': {
        const h = headerWriter()
          .str('type', 'start')
          .str('messageId', chunk.messageId ?? this._messageId)
          .json('messageMetadata', chunk.messageMetadata)
          .build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', headers: h }, perWrite);
        return;
      }
      case 'start-step': {
        const h = headerWriter().str('type', 'start-step').build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', headers: h }, perWrite);
        return;
      }
      case 'finish-step': {
        const h = headerWriter().str('type', 'finish-step').build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', headers: h }, perWrite);
        return;
      }
      case 'finish': {
        const h = headerWriter()
          .str('type', 'finish')
          .str('finishReason', chunk.finishReason)
          .json('messageMetadata', chunk.messageMetadata)
          .build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', headers: h }, perWrite);
        return;
      }
      case 'error': {
        const h = headerWriter().str('type', 'error').build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: chunk.errorText, headers: h }, perWrite);
        return;
      }
      case 'abort': {
        this._cancelled = true;
        await this._core.cancelAllStreams(perWrite);
        await this._core.publishDiscrete(
          {
            name: EVENT_AI_OUTPUT,
            data: chunk.reason ?? '',
            headers: { ...headerWriter().str('type', 'abort').build(), [HEADER_STATUS]: 'cancelled' },
          },
          perWrite,
        );
        return;
      }
      case 'message-metadata': {
        const h = headerWriter().str('type', 'message-metadata').json('messageMetadata', chunk.messageMetadata).build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', headers: h }, perWrite);
        return;
      }

      // -- Tool lifecycle (discrete) ----------------------------------------
      case 'tool-input-error': {
        const h = headerWriter()
          .str('type', 'tool-input-error')
          .str('toolCallId', chunk.toolCallId)
          .str('toolName', chunk.toolName)
          .bool('dynamic', chunk.dynamic)
          .str('title', chunk.title)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete(
          { name: EVENT_AI_OUTPUT, data: { errorText: chunk.errorText, input: chunk.input }, headers: h },
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
          .str('type', 'file')
          .str('mediaType', chunk.mediaType)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: chunk.url, headers: h }, perWrite);
        return;
      }
      case 'source-url': {
        const h = headerWriter()
          .str('type', 'source-url')
          .str('sourceId', chunk.sourceId)
          .str('title', chunk.title)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: chunk.url, headers: h }, perWrite);
        return;
      }
      case 'source-document': {
        const h = headerWriter()
          .str('type', 'source-document')
          .str('sourceId', chunk.sourceId)
          .str('mediaType', chunk.mediaType)
          .str('title', chunk.title)
          .str('filename', chunk.filename)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', headers: h }, perWrite);
        return;
      }

      // -- data-* (discrete) ------------------------------------------------
      default: {
        if (chunk.type.startsWith('data-')) {
          // CAST: data-* chunks always have id, transient, and data fields per AI SDK types.
          // TypeScript can't narrow the template literal union in a default case.
          const dataChunk = chunk;
          const h = headerWriter()
            .str('type', dataChunk.type)
            .str('id', dataChunk.id)
            .bool('transient', dataChunk.transient)
            .build();
          const ephemeral = dataChunk.transient === true;
          await this._core.publishDiscrete(
            { name: EVENT_AI_OUTPUT, data: dataChunk.data, headers: h, ephemeral },
            perWrite,
          );
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
    // Stamp role on every payload so the decoder can reconstruct a `role: 'user'` UIMessage.
    for (const payload of payloads) {
      payload.headers = { ...payload.headers, [HEADER_ROLE]: 'user' };
    }
    await this._core.publishDiscreteBatch(payloads, perWrite);
  }

  /**
   * Publish a client-side tool-approval response as a discrete
   * `tool-approval-response` Ably message. The publish carries its own
   * `x-ably-codec-message-id` (from `perWrite.messageId`) — the reducer matches the
   * response to the original assistant by `toolCallId`, not by codec-message-id.
   * @param event - The approval-response TEvent (toolCallId, approved, optional reason).
   * @param perWrite - Optional per-write overrides (clientId, extras, messageId).
   */
  private async _publishToolApprovalResponse(event: ToolApprovalResponseEvent, perWrite?: WriteOptions): Promise<void> {
    const h = headerWriter()
      .str('toolCallId', event.toolCallId)
      .bool('approved', event.approved)
      .str('reason', event.reason)
      .build();
    await this._core.publishDiscrete({ name: 'tool-approval-response', data: '', headers: h }, perWrite);
  }

  /**
   * Publish a regenerate event as a discrete `ait-regenerate` Ably message.
   * The wire carries no domain payload — `parent`/`forkOf` are stamped on the
   * transport headers by the client-session (it builds them via
   * `buildTransportHeaders` from the event's `parentCodecMessageId`/`forkOfCodecMessageId`
   * which `classifyEvent` surfaces on the `regenerate` classification).
   * @param _event - The regenerate TEvent (unused — metadata is on transport headers).
   * @param perWrite - Per-write overrides carrying the transport headers built by client-session.
   */
  private async _publishRegenerate(_event: RegenerateEvent, perWrite?: WriteOptions): Promise<void> {
    await this._core.publishDiscrete({ name: 'ait-regenerate', data: '', headers: {} }, perWrite);
  }
}

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
        .str('type', 'tool-output-available')
        .str('toolCallId', chunk.toolCallId)
        .bool('dynamic', chunk.dynamic)
        .bool('providerExecuted', chunk.providerExecuted)
        .bool('preliminary', chunk.preliminary)
        .build();
      return { name: EVENT_AI_OUTPUT, data: { output: chunk.output }, headers: h };
    }
    case 'tool-output-error': {
      const h = headerWriter()
        .str('type', 'tool-output-error')
        .str('toolCallId', chunk.toolCallId)
        .bool('dynamic', chunk.dynamic)
        .bool('providerExecuted', chunk.providerExecuted)
        .build();
      return { name: EVENT_AI_OUTPUT, data: { errorText: chunk.errorText }, headers: h };
    }
    case 'tool-approval-request': {
      const h = headerWriter()
        .str('type', 'tool-approval-request')
        .str('toolCallId', chunk.toolCallId)
        .str('approvalId', chunk.approvalId)
        .build();
      return { name: EVENT_AI_OUTPUT, data: '', headers: h };
    }
    case 'tool-output-denied': {
      const h = headerWriter().str('type', 'tool-output-denied').str('toolCallId', chunk.toolCallId).build();
      return { name: EVENT_AI_OUTPUT, data: '', headers: h };
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
