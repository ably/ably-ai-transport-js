/**
 * Vercel AI SDK Encoder
 *
 * Maps UIMessageChunk events and complete UIMessage objects to Ably channel
 * operations (publish, appendMessage, updateMessage).
 *
 * Delegates the mutable message lifecycle (publish, append, close, abort,
 * flush/recover) to the encoder core. This file contains only the
 * Vercel-specific event-to-operation mapping.
 *
 * Domain-specific headers use the `x-domain-` prefix to distinguish them
 * from transport-level `x-ably-` headers.
 *
 * ## Core operations and domain headers
 *
 * Each UIMessageChunk maps to exactly one encoder core operation. Domain
 * headers are passed to every operation that accepts them — the core handles
 * merging, persistence, and deduplication:
 *
 * - **`startStream`**: Opens a mutable message. Domain headers become
 *   "persistent headers" — the core repeats them on every subsequent append.
 * - **`appendStream`**: Appends a text delta. Data only, no headers parameter.
 *   The core automatically carries persistent headers from start.
 * - **`closeStream`**: Closes the stream. Pass all domain headers from the
 *   chunk — the core merges them on top of persistent headers, so changed
 *   values (e.g. updated providerMetadata) are picked up and unchanged
 *   values are harmlessly deduplicated.
 * - **`publishDiscrete`**: Publishes a standalone message. All domain headers
 *   for the chunk are passed directly.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { isDataUIPart } from 'ai';

import { HEADER_STATUS } from '../../constants.js';
import type { EncoderCore, EncoderCoreOptions } from '../../core/codec/encoder.js';
import { createEncoderCore } from '../../core/codec/encoder.js';
import type { ChannelWriter, MessagePayload, StreamEncoder, WriteOptions } from '../../core/codec/types.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import { headerWriter } from '../../utils.js';

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultUIMessageEncoder implements StreamEncoder<AI.UIMessageChunk, AI.UIMessage> {
  private readonly _core: EncoderCore;
  private _aborted = false;

  constructor(writer: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._core = createEncoderCore(writer, options);
  }

  async appendEvent(chunk: AI.UIMessageChunk, perWrite?: WriteOptions): Promise<void> {
    switch (chunk.type) {
      // -- Stream start: open a mutable message with persistent headers -----

      case 'text-start': {
        const h = headerWriter().str('id', chunk.id).json('providerMetadata', chunk.providerMetadata).build();
        await this._core.startStream(chunk.id, { name: 'text', data: '', headers: h }, perWrite);
        break;
      }

      case 'reasoning-start': {
        const h = headerWriter().str('id', chunk.id).json('providerMetadata', chunk.providerMetadata).build();
        await this._core.startStream(chunk.id, { name: 'reasoning', data: '', headers: h }, perWrite);
        break;
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
        break;
      }

      // -- Stream append: data only, core carries persistent headers --------

      case 'text-delta': {
        this._core.appendStream(chunk.id, chunk.delta);
        break;
      }

      case 'reasoning-delta': {
        this._core.appendStream(chunk.id, chunk.delta);
        break;
      }

      case 'tool-input-delta': {
        this._core.appendStream(chunk.toolCallId, chunk.inputTextDelta);
        break;
      }

      // -- Stream close: pass all chunk headers, core merges with persistent

      case 'text-end': {
        const h = headerWriter().str('id', chunk.id).json('providerMetadata', chunk.providerMetadata).build();
        await this._core.closeStream(chunk.id, { name: 'text', data: '', headers: h });
        break;
      }

      case 'reasoning-end': {
        const h = headerWriter().str('id', chunk.id).json('providerMetadata', chunk.providerMetadata).build();
        await this._core.closeStream(chunk.id, { name: 'reasoning', data: '', headers: h });
        break;
      }

      case 'tool-input-available': {
        // If a stream tracker exists, this tool call was streamed — close it.
        // Otherwise it's a non-streaming tool call — publish discrete.
        try {
          const h = headerWriter()
            .str('toolCallId', chunk.toolCallId)
            .str('toolName', chunk.toolName)
            .json('providerMetadata', chunk.providerMetadata)
            .build();
          await this._core.closeStream(chunk.toolCallId, { name: 'tool-input', data: '', headers: h });
        } catch (error: unknown) {
          // Only fall through to discrete for "no active stream" — rethrow real failures
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
        break;
      }

      // -- Discrete: lifecycle events ---------------------------------------

      case 'start': {
        const h = headerWriter()
          .str('messageId', chunk.messageId)
          .json('messageMetadata', chunk.messageMetadata)
          .build();
        await this._core.publishDiscrete({ name: 'start', data: '', headers: h }, perWrite);
        break;
      }

      case 'start-step': {
        await this._core.publishDiscrete({ name: 'start-step', data: '' }, perWrite);
        break;
      }

      case 'finish-step': {
        await this._core.publishDiscrete({ name: 'finish-step', data: '' }, perWrite);
        break;
      }

      case 'finish': {
        const h = headerWriter()
          .str('finishReason', chunk.finishReason)
          .json('messageMetadata', chunk.messageMetadata)
          .build();
        await this._core.publishDiscrete({ name: 'finish', data: '', headers: h }, perWrite);
        break;
      }

      case 'error': {
        await this._core.publishDiscrete({ name: 'error', data: chunk.errorText }, perWrite);
        break;
      }

      case 'abort': {
        this._aborted = true;
        await this._core.abortAllStreams(perWrite);
        await this._core.publishDiscrete(
          { name: 'abort', data: chunk.reason ?? '', headers: { [HEADER_STATUS]: 'aborted' } },
          perWrite,
        );
        break;
      }

      // -- Discrete: tool lifecycle events ----------------------------------

      case 'tool-input-error': {
        const h = headerWriter()
          .str('toolCallId', chunk.toolCallId)
          .str('toolName', chunk.toolName)
          .bool('dynamic', chunk.dynamic)
          .str('title', chunk.title)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({
          name: 'tool-input-error',
          data: { errorText: chunk.errorText, input: chunk.input },
          headers: h,
        });
        break;
      }

      case 'tool-output-available': {
        const h = headerWriter()
          .str('toolCallId', chunk.toolCallId)
          .bool('dynamic', chunk.dynamic)
          .bool('providerExecuted', chunk.providerExecuted)
          .bool('preliminary', chunk.preliminary)
          .build();
        await this._core.publishDiscrete({
          name: 'tool-output-available',
          data: { output: chunk.output },
          headers: h,
        });
        break;
      }

      case 'tool-output-error': {
        const h = headerWriter()
          .str('toolCallId', chunk.toolCallId)
          .bool('dynamic', chunk.dynamic)
          .bool('providerExecuted', chunk.providerExecuted)
          .build();
        await this._core.publishDiscrete({
          name: 'tool-output-error',
          data: { errorText: chunk.errorText },
          headers: h,
        });
        break;
      }

      case 'tool-approval-request': {
        const h = headerWriter().str('toolCallId', chunk.toolCallId).str('approvalId', chunk.approvalId).build();
        await this._core.publishDiscrete({ name: 'tool-approval-request', data: '', headers: h }, perWrite);
        break;
      }

      case 'tool-output-denied': {
        const h = headerWriter().str('toolCallId', chunk.toolCallId).build();
        await this._core.publishDiscrete({ name: 'tool-output-denied', data: '', headers: h }, perWrite);
        break;
      }

      // -- Discrete: content parts ------------------------------------------

      case 'file': {
        const h = headerWriter()
          .str('mediaType', chunk.mediaType)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({ name: 'file', data: chunk.url, headers: h }, perWrite);
        break;
      }

      case 'source-url': {
        const h = headerWriter()
          .str('sourceId', chunk.sourceId)
          .str('title', chunk.title)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({ name: 'source-url', data: chunk.url, headers: h }, perWrite);
        break;
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
        break;
      }

      case 'message-metadata': {
        const h = headerWriter().json('messageMetadata', chunk.messageMetadata).build();
        await this._core.publishDiscrete({ name: 'message-metadata', data: '', headers: h }, perWrite);
        break;
      }

      // -- Discrete: data-* custom chunks -----------------------------------

      default: {
        if (chunk.type.startsWith('data-')) {
          const h = headerWriter().str('id', chunk.id).bool('transient', chunk.transient).build();
          const ephemeral = chunk.transient === true;
          await this._core.publishDiscrete({ name: chunk.type, data: chunk.data, headers: h, ephemeral }, perWrite);
        }
        break;
      }
    }
  }

  async writeEvent(chunk: AI.UIMessageChunk, perWrite?: WriteOptions): Promise<Ably.PublishResult> {
    if (!chunk.type.startsWith('data-')) {
      throw new Ably.ErrorInfo(
        `unable to write event; only data-* chunk types are supported, got '${chunk.type}'`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const h = headerWriter()
      .str('id', 'id' in chunk ? chunk.id : undefined)
      .bool('transient', 'transient' in chunk ? chunk.transient : undefined)
      .build();
    const ephemeral = 'transient' in chunk && chunk.transient === true;
    return this._core.publishDiscrete(
      { name: chunk.type, data: 'data' in chunk ? chunk.data : undefined, headers: h, ephemeral },
      perWrite,
    );
  }

  async writeMessage(message: AI.UIMessage, perWrite?: WriteOptions): Promise<Ably.PublishResult> {
    const payloads = encodeMessagePayloads(message);
    return this._core.publishDiscreteBatch(payloads, perWrite);
  }

  async writeMessages(messages: AI.UIMessage[], perWrite?: WriteOptions): Promise<Ably.PublishResult> {
    const payloads = messages.flatMap((msg) => encodeMessagePayloads(msg));
    return this._core.publishDiscreteBatch(payloads, perWrite);
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
}

// ---------------------------------------------------------------------------
// Message payload encoding (stateless helper)
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
 * Create a Vercel AI SDK encoder that maps UIMessageChunk events to Ably
 * channel operations via the encoder core.
 * @param writer - The channel writer to publish messages through.
 * @param options - Encoder configuration (clientId, extras, hooks, logger).
 * @returns A {@link StreamEncoder} for UIMessageChunk/UIMessage.
 */
export const createEncoder = (
  writer: ChannelWriter,
  options: EncoderCoreOptions = {},
): StreamEncoder<AI.UIMessageChunk, AI.UIMessage> => new DefaultUIMessageEncoder(writer, options);
