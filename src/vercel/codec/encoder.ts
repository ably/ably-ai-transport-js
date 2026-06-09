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
 * core; only the output direction (text / reasoning / tool-input chunks)
 * drives it — inputs are always published as discrete messages.
 */

import type * as AI from 'ai';
import { isDataUIPart } from 'ai';

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT, HEADER_ROLE, HEADER_STATUS } from '../../constants.js';
import { createDescriptorEncoder, type DescriptorEncoder } from '../../core/codec/descriptor-encoder.js';
import type { EncoderCore, EncoderCoreOptions } from '../../core/codec/encoder.js';
import { createEncoderCore } from '../../core/codec/encoder.js';
import type {
  ChannelWriter,
  Encoder,
  MessagePayload,
  ToolApprovalResponse,
  ToolResult,
  ToolResultError,
  UserMessage,
  WriteOptions,
} from '../../core/codec/types.js';
import type {
  VercelInput,
  VercelOutput,
  VercelToolApprovalResponsePayload,
  VercelToolResultErrorPayload,
  VercelToolResultPayload,
} from './events.js';
import { fApproved, fId, fMediaType, fMessageId, fReason, fToolCallId, fType } from './fields.js';
import { outputs } from './outputs.js';

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultUIMessageEncoder implements Encoder<VercelInput, VercelOutput> {
  private readonly _core: EncoderCore;
  private readonly _messageId: string | undefined;
  private readonly _outputEncoder: DescriptorEncoder<VercelOutput>;
  private _cancelled = false;

  constructor(writer: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._core = createEncoderCore(writer, options);
    this._messageId = options.messageId;
    this._outputEncoder = createDescriptorEncoder(outputs, EVENT_AI_OUTPUT);
  }

  async publishInput(input: VercelInput, options?: WriteOptions): Promise<void> {
    switch (input.kind) {
      case 'user-message': {
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
    // The abort chunk marks the encoder cancelled so a later cancel() is a no-op,
    // mirroring cancel()'s own guard; the descriptor's encode hatch performs the
    // cancel-and-publish.
    if (output.type === 'abort') this._cancelled = true;
    await this._outputEncoder.encode(output, this._core, { messageId: this._messageId, opts: options });
  }

  async cancel(reason?: string): Promise<void> {
    if (this._cancelled) return;
    this._cancelled = true;
    await this._core.cancelAllStreams();
    const codecHeaders: Record<string, string> = {};
    fType.write(codecHeaders, 'abort');
    await this._core.publishDiscrete({
      name: EVENT_AI_OUTPUT,
      data: reason ?? '',
      codecHeaders,
      transportHeaders: { [HEADER_STATUS]: 'cancelled' },
    });
  }

  async close(): Promise<void> {
    await this._core.close();
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
  private async _publishUserMessage(input: UserMessage<AI.UIMessage>, perWrite?: WriteOptions): Promise<void> {
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
    const codecHeaders: Record<string, string> = {};
    fType.write(codecHeaders, 'regenerate');
    await this._core.publishDiscrete({ name: EVENT_AI_INPUT, data: '', codecHeaders }, perWrite);
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
    const codecHeaders: Record<string, string> = {};
    fType.write(codecHeaders, 'tool-result');
    fToolCallId.write(codecHeaders, input.payload.toolCallId);
    await this._core.publishDiscrete(
      { name: EVENT_AI_INPUT, data: { output: input.payload.output }, codecHeaders },
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
    const codecHeaders: Record<string, string> = {};
    fType.write(codecHeaders, 'tool-result-error');
    fToolCallId.write(codecHeaders, input.payload.toolCallId);
    await this._core.publishDiscrete(
      { name: EVENT_AI_INPUT, data: { message: input.payload.message }, codecHeaders },
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
    const codecHeaders: Record<string, string> = {};
    fType.write(codecHeaders, 'tool-approval-response');
    fToolCallId.write(codecHeaders, input.payload.toolCallId);
    fApproved.write(codecHeaders, input.payload.approved);
    fReason.write(codecHeaders, input.payload.reason);
    await this._core.publishDiscrete({ name: EVENT_AI_INPUT, data: '', codecHeaders }, perWrite);
  }
}

// ---------------------------------------------------------------------------
// User-message per-part payload encoding
// ---------------------------------------------------------------------------

const encodeMessagePayloads = (message: AI.UIMessage): MessagePayload[] => {
  const messageId = message.id;
  const payloads: MessagePayload[] = [];

  for (const part of message.parts) {
    switch (part.type) {
      case 'text': {
        const codecHeaders: Record<string, string> = {};
        fType.write(codecHeaders, 'text');
        fMessageId.write(codecHeaders, messageId);
        payloads.push({ name: EVENT_AI_INPUT, data: part.text, codecHeaders });
        break;
      }
      case 'file': {
        const codecHeaders: Record<string, string> = {};
        fType.write(codecHeaders, 'file');
        fMessageId.write(codecHeaders, messageId);
        fMediaType.write(codecHeaders, part.mediaType);
        payloads.push({ name: EVENT_AI_INPUT, data: part.url, codecHeaders });
        break;
      }
      default: {
        if (isDataUIPart(part)) {
          const codecHeaders: Record<string, string> = {};
          fType.write(codecHeaders, part.type);
          fMessageId.write(codecHeaders, messageId);
          fId.write(codecHeaders, part.id);
          payloads.push({ name: EVENT_AI_INPUT, data: part.data, codecHeaders });
        }
        break;
      }
    }
  }

  if (payloads.length === 0) {
    // Always emit at least one part so the decoder can reconstruct the codec-message-id and role from headers, even when the user-message carried no encodable parts.
    const codecHeaders: Record<string, string> = {};
    fType.write(codecHeaders, 'text');
    fMessageId.write(codecHeaders, messageId);
    payloads.push({ name: EVENT_AI_INPUT, data: '', codecHeaders });
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
 * @param options - Encoder configuration (extras, hooks, logger).
 * @returns An {@link Encoder} typed in both directions for the Vercel codec.
 */
export const createEncoder = (
  writer: ChannelWriter,
  options: EncoderCoreOptions = {},
): Encoder<VercelInput, VercelOutput> => new DefaultUIMessageEncoder(writer, options);
