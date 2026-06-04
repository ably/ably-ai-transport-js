/**
 * Vercel AI SDK encoder.
 *
 * Two publish methods enforce direction at the call site:
 *
 * - {@link DefaultUIMessageEncoder.publishInput} encodes a `VercelInput`
 *   variant and publishes it on the `ai-input` wire.
 * - {@link DefaultUIMessageEncoder.publishOutput} encodes a `VercelOutput`
 *   (`AI.UIMessageChunk`) and publishes it on the `ai-output` wire,
 *   driving the underlying stream-tracker for streamed chunks
 *   (text / reasoning / tool-input) and falling back to discrete
 *   publishes for everything else.
 *
 * The codec event's own discriminator (`kind` for inputs, `type` for
 * outputs) is carried in the codec tier's `type` header so the
 * decoder can dispatch. Stream-tracker state lives inside the encoder
 * core and is shared across both directions.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { isDataUIPart } from 'ai';

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT, HEADER_ROLE, HEADER_STATUS } from '../../constants.js';
import type { EncoderCore, EncoderCoreOptions } from '../../core/codec/encoder.js';
import { createEncoderCore } from '../../core/codec/encoder.js';
import type {
  ChannelWriter,
  Edit,
  Encoder,
  MessagePayload,
  ToolApprovalResponse,
  ToolResult,
  ToolResultError,
  UserMessage,
  WriteOptions,
} from '../../core/codec/types.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import { headerWriter } from '../../utils.js';
import type {
  VercelInput,
  VercelOutput,
  VercelToolApprovalResponsePayload,
  VercelToolResultErrorPayload,
  VercelToolResultPayload,
} from './events.js';

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultUIMessageEncoder implements Encoder<VercelInput, VercelOutput> {
  private readonly _core: EncoderCore;
  private readonly _messageId: string | undefined;
  private _cancelled = false;

  constructor(writer: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._core = createEncoderCore(writer, options);
    this._messageId = options.messageId;
  }

  async publishInput(input: VercelInput, options?: WriteOptions): Promise<void> {
    switch (input.kind) {
      case 'user-message': {
        await this._publishUserMessage(input, options);
        return;
      }
      case 'edit': {
        // An edit publishes its replacement message identically to a fresh
        // user message; the fork routing (target -> fork-of) is stamped on
        // the transport headers by the client-session.
        await this._publishUserMessage(input, options);
        return;
      }
      case 'regenerate': {
        await this._publishRegenerate(options);
        return;
      }
      case 'tool-result': {
        await this._publishToolResult(input, options);
        return;
      }
      case 'tool-result-error': {
        await this._publishToolResultError(input, options);
        return;
      }
      case 'tool-approval-response': {
        await this._publishToolApprovalResponse(input, options);
        return;
      }
    }
  }

  async publishOutput(output: VercelOutput, options?: WriteOptions): Promise<void> {
    await this._publishChunk(output, options);
  }

  async cancel(reason?: string): Promise<void> {
    if (this._cancelled) return;
    this._cancelled = true;
    await this._core.cancelAllStreams();
    await this._core.publishDiscrete({
      name: EVENT_AI_OUTPUT,
      data: reason ?? '',
      codecHeaders: headerWriter().str('type', 'abort').build(),
      transportHeaders: { [HEADER_STATUS]: 'cancelled' },
    });
  }

  async close(): Promise<void> {
    await this._core.close();
  }

  // -------------------------------------------------------------------------
  // VercelOutput routing — UIMessageChunk
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
        await this._core.startStream(chunk.id, { name: EVENT_AI_OUTPUT, data: '', codecHeaders: h }, perWrite);
        return;
      }
      case 'reasoning-start': {
        const h = headerWriter()
          .str('type', 'reasoning')
          .str('id', chunk.id)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.startStream(chunk.id, { name: EVENT_AI_OUTPUT, data: '', codecHeaders: h }, perWrite);
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
        await this._core.startStream(chunk.toolCallId, { name: EVENT_AI_OUTPUT, data: '', codecHeaders: h }, perWrite);
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
        await this._core.closeStream(chunk.id, { name: EVENT_AI_OUTPUT, data: '', codecHeaders: h });
        return;
      }
      case 'reasoning-end': {
        const h = headerWriter()
          .str('type', 'reasoning')
          .str('id', chunk.id)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.closeStream(chunk.id, { name: EVENT_AI_OUTPUT, data: '', codecHeaders: h });
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
          await this._core.closeStream(chunk.toolCallId, { name: EVENT_AI_OUTPUT, data: '', codecHeaders: h });
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
          await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: chunk.input, codecHeaders: h });
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
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', codecHeaders: h }, perWrite);
        return;
      }
      case 'start-step': {
        const h = headerWriter().str('type', 'start-step').build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', codecHeaders: h }, perWrite);
        return;
      }
      case 'finish-step': {
        const h = headerWriter().str('type', 'finish-step').build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', codecHeaders: h }, perWrite);
        return;
      }
      case 'finish': {
        const h = headerWriter()
          .str('type', 'finish')
          .str('finishReason', chunk.finishReason)
          .json('messageMetadata', chunk.messageMetadata)
          .build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', codecHeaders: h }, perWrite);
        return;
      }
      case 'error': {
        const h = headerWriter().str('type', 'error').build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: chunk.errorText, codecHeaders: h }, perWrite);
        return;
      }
      case 'abort': {
        this._cancelled = true;
        await this._core.cancelAllStreams(perWrite);
        await this._core.publishDiscrete(
          {
            name: EVENT_AI_OUTPUT,
            data: chunk.reason ?? '',
            codecHeaders: headerWriter().str('type', 'abort').build(),
            transportHeaders: { [HEADER_STATUS]: 'cancelled' },
          },
          perWrite,
        );
        return;
      }
      case 'message-metadata': {
        const h = headerWriter().str('type', 'message-metadata').json('messageMetadata', chunk.messageMetadata).build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', codecHeaders: h }, perWrite);
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
          { name: EVENT_AI_OUTPUT, data: { errorText: chunk.errorText, input: chunk.input }, codecHeaders: h },
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
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: chunk.url, codecHeaders: h }, perWrite);
        return;
      }
      case 'source-url': {
        const h = headerWriter()
          .str('type', 'source-url')
          .str('sourceId', chunk.sourceId)
          .str('title', chunk.title)
          .json('providerMetadata', chunk.providerMetadata)
          .build();
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: chunk.url, codecHeaders: h }, perWrite);
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
        await this._core.publishDiscrete({ name: EVENT_AI_OUTPUT, data: '', codecHeaders: h }, perWrite);
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
            { name: EVENT_AI_OUTPUT, data: dataChunk.data, codecHeaders: h, ephemeral },
            perWrite,
          );
          return;
        }
        throw new Ably.ErrorInfo(
          `unable to publish output; unsupported chunk type '${chunk.type}'`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // VercelInput routing
  // -------------------------------------------------------------------------

  /**
   * Publish a user-message input as a batch of per-part discrete Ably
   * messages on the `ai-input` wire. Wire format matches the multi-part
   * user-message convention; the receive-side decoder fans the parts back
   * out into a single `UserMessage`.
   * @param input - The user-message input carrying the UIMessage to encode.
   * @param perWrite - Optional per-write overrides.
   */
  private async _publishUserMessage(
    input: UserMessage<AI.UIMessage> | Edit<AI.UIMessage>,
    perWrite?: WriteOptions,
  ): Promise<void> {
    const payloads = encodeMessagePayloads(input.message);
    // Stamp role (a transport header) on every payload so the decoder can
    // reconstruct a `role: 'user'` UIMessage.
    for (const payload of payloads) {
      payload.transportHeaders = { ...payload.transportHeaders, [HEADER_ROLE]: 'user' };
    }
    await this._core.publishDiscreteBatch(payloads, perWrite);
  }

  /**
   * Publish a regenerate input as a discrete `ai-input` Ably message
   * carrying codec `type: 'regenerate'`. The wire carries no domain
   * payload — `parent` / `target` are stamped on the transport headers by
   * the client-session (it reads them off the input directly and builds
   * `buildTransportHeaders`).
   * @param perWrite - Per-write overrides carrying the transport headers built by client-session.
   */
  private async _publishRegenerate(perWrite?: WriteOptions): Promise<void> {
    const h = headerWriter().str('type', 'regenerate').build();
    await this._core.publishDiscrete({ name: EVENT_AI_INPUT, data: '', codecHeaders: h }, perWrite);
  }

  /**
   * Publish a client-side tool output on the `ai-input` wire. Targets the
   * assistant addressed by `input.codecMessageId`; the wire's
   * `codec-message-id` is stamped via `perWrite.messageId` by the
   * client-session.
   * @param input - The tool-output input.
   * @param perWrite - Per-write overrides carrying the wire codecMessageId.
   */
  private async _publishToolResult(input: ToolResult<VercelToolResultPayload>, perWrite?: WriteOptions): Promise<void> {
    const h = headerWriter().str('type', 'tool-result').str('toolCallId', input.payload.toolCallId).build();
    await this._core.publishDiscrete(
      { name: EVENT_AI_INPUT, data: { output: input.payload.output }, codecHeaders: h },
      perWrite,
    );
  }

  /**
   * Publish a client-side tool error on the `ai-input` wire. Targets the
   * assistant addressed by `input.codecMessageId`.
   * @param input - The tool-result-error input.
   * @param perWrite - Per-write overrides.
   */
  private async _publishToolResultError(
    input: ToolResultError<VercelToolResultErrorPayload>,
    perWrite?: WriteOptions,
  ): Promise<void> {
    const h = headerWriter().str('type', 'tool-result-error').str('toolCallId', input.payload.toolCallId).build();
    await this._core.publishDiscrete(
      { name: EVENT_AI_INPUT, data: { message: input.payload.message }, codecHeaders: h },
      perWrite,
    );
  }

  /**
   * Publish a client-side tool approval response on the `ai-input` wire.
   * Targets the assistant addressed by `input.codecMessageId`.
   * @param input - The approval-response input.
   * @param perWrite - Per-write overrides.
   */
  private async _publishToolApprovalResponse(
    input: ToolApprovalResponse<VercelToolApprovalResponsePayload>,
    perWrite?: WriteOptions,
  ): Promise<void> {
    const h = headerWriter()
      .str('type', 'tool-approval-response')
      .str('toolCallId', input.payload.toolCallId)
      .bool('approved', input.payload.approved)
      .str('reason', input.payload.reason)
      .build();
    await this._core.publishDiscrete({ name: EVENT_AI_INPUT, data: '', codecHeaders: h }, perWrite);
  }
}

// ---------------------------------------------------------------------------
// Tool output discrete payload builder (agent-side `ai-output` wire)
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
      return { name: EVENT_AI_OUTPUT, data: { output: chunk.output }, codecHeaders: h };
    }
    case 'tool-output-error': {
      const h = headerWriter()
        .str('type', 'tool-output-error')
        .str('toolCallId', chunk.toolCallId)
        .bool('dynamic', chunk.dynamic)
        .bool('providerExecuted', chunk.providerExecuted)
        .build();
      return { name: EVENT_AI_OUTPUT, data: { errorText: chunk.errorText }, codecHeaders: h };
    }
    case 'tool-approval-request': {
      const h = headerWriter()
        .str('type', 'tool-approval-request')
        .str('toolCallId', chunk.toolCallId)
        .str('approvalId', chunk.approvalId)
        .build();
      return { name: EVENT_AI_OUTPUT, data: '', codecHeaders: h };
    }
    case 'tool-output-denied': {
      const h = headerWriter().str('type', 'tool-output-denied').str('toolCallId', chunk.toolCallId).build();
      return { name: EVENT_AI_OUTPUT, data: '', codecHeaders: h };
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
        payloads.push({
          name: EVENT_AI_INPUT,
          data: part.text,
          codecHeaders: headerWriter().str('type', 'text').str('messageId', messageId).build(),
        });
        break;
      }
      case 'file': {
        payloads.push({
          name: EVENT_AI_INPUT,
          data: part.url,
          codecHeaders: headerWriter()
            .str('type', 'file')
            .str('messageId', messageId)
            .str('mediaType', part.mediaType)
            .build(),
        });
        break;
      }
      default: {
        if (isDataUIPart(part)) {
          payloads.push({
            name: EVENT_AI_INPUT,
            data: part.data,
            codecHeaders: headerWriter().str('type', part.type).str('messageId', messageId).str('id', part.id).build(),
          });
        }
        break;
      }
    }
  }

  if (payloads.length === 0) {
    payloads.push({
      name: EVENT_AI_INPUT,
      data: '',
      codecHeaders: headerWriter().str('type', 'text').str('messageId', messageId).build(),
    });
  }

  return payloads;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel AI SDK encoder that maps VercelInput / VercelOutput to
 * Ably channel operations via the encoder core.
 * @param writer - The channel writer to publish messages through.
 * @param options - Encoder configuration (clientId, extras, hooks, logger).
 * @returns An {@link Encoder} typed in both directions for the Vercel codec.
 */
export const createEncoder = (
  writer: ChannelWriter,
  options: EncoderCoreOptions = {},
): Encoder<VercelInput, VercelOutput> => new DefaultUIMessageEncoder(writer, options);
