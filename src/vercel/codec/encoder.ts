import * as Ably from 'ably';
import type * as AI from 'ai';

import type {
  CreateEncoderArgs,
  EncodeEventOptions,
  EncodeOptions,
  Encoder,
  EncoderCore,
} from '../../core/codec/index.js';
import { headerWriter } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';

/**
 * Wire message name carrying a streamed tool-input. The streaming open
 * publishes `name: 'tool-input'` keyed by `toolCallId`; deltas append the
 * raw `inputTextDelta` strings; the closing append carries the parsed
 * `input` (and, for input-error, an `errorText`) in domain headers.
 */
const TOOL_INPUT_WIRE_NAME = 'tool-input';

/** Discrete wire name for `tool-output-available` chunks. */
const TOOL_OUTPUT_AVAILABLE_WIRE_NAME = 'tool-output-available';

/** Discrete wire name for `tool-output-error` chunks. */
const TOOL_OUTPUT_ERROR_WIRE_NAME = 'tool-output-error';

/**
 * Discrete wire name for the step-boundary marker. The AI SDK emits a
 * `start-step` chunk at the beginning of every model step (the chunk
 * vocabulary uses verb form); the receiving accumulator translates that
 * into a `{ type: 'step-start' }` part on the assembled `UIMessage`.
 * `convertToModelMessages` reads those parts to split the assistant
 * message into per-step blocks — without them, a tool call and the
 * model's reply text fold into a single assistant block, which
 * downstream providers (Anthropic) reject because the tool_use no
 * longer ends the assistant message.
 */
const STEP_START_WIRE_NAME = 'step-start';

/**
 * Vercel encoder. Wraps an {@link EncoderCore} and maps `UIMessageChunk`
 * events plus complete `UIMessage` objects onto the core's primitives.
 *
 * Handles text streaming (`text-*`) and tool-input streaming (`tool-input-*`).
 * Every other chunk type (lifecycle markers, tool output, reasoning, files,
 * source documents, `data-*`, etc.) is silently dropped with a debug log
 * so an agent's `agent.stream(...)` output flows through unchanged — only
 * the supported chunks reach the wire. Tool output and the rest of the
 * chunk vocabulary land in follow-up phases.
 */
class DefaultUIMessageEncoder implements Encoder<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> {
  private readonly _core: EncoderCore;
  private readonly _logger: Logger | undefined;

  constructor(args: CreateEncoderArgs) {
    this._core = args.core;
    this._logger = args.logger?.withContext({ component: 'UIMessageEncoder' });
  }

  async encodePart(chunk: AI.UIMessageChunk, options?: EncodeOptions): Promise<void> {
    this._logger?.trace('DefaultUIMessageEncoder.encodePart();', { chunkType: chunk.type });

    switch (chunk.type) {
      case 'text-start': {
        const headers = headerWriter().str('id', chunk.id).build();
        await this._core.startStream(
          chunk.id,
          { name: 'text', data: '' },
          { headers: { ...options?.headers, ...headers } },
        );
        return;
      }
      case 'text-delta': {
        this._core.appendStream(chunk.id, chunk.delta);
        return;
      }
      case 'text-end': {
        const headers = headerWriter().str('id', chunk.id).build();
        await this._core.closeStream(
          chunk.id,
          { name: 'text', data: '' },
          { headers: { ...options?.headers, ...headers } },
        );
        return;
      }
      case 'tool-input-start': {
        // Open a streaming wire keyed by toolCallId. Tool metadata stamps
        // domain headers on the create; the encoder core re-applies these
        // persistent headers on every subsequent append/close so the
        // decoder can recover toolName / dynamic / title even from a
        // history-only replay that didn't see the start in real time.
        const headers = headerWriter()
          .str('toolName', chunk.toolName)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .bool('dynamic', chunk.dynamic)
          .str('title', chunk.title)
          .build();
        await this._core.startStream(
          chunk.toolCallId,
          { name: TOOL_INPUT_WIRE_NAME, data: '' },
          { headers: { ...options?.headers, ...headers } },
        );
        return;
      }
      case 'tool-input-delta': {
        this._core.appendStream(chunk.toolCallId, chunk.inputTextDelta);
        return;
      }
      case 'tool-input-available': {
        // Close the input stream with the parsed input in a domain header.
        // Re-stamp the chunk's metadata so the close wire carries the
        // authoritative values for fields the AI SDK allows the chunk to
        // refresh (toolName / providerExecuted / providerMetadata /
        // dynamic / title).
        const headers = headerWriter()
          .str('toolName', chunk.toolName)
          .json('input', chunk.input)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .bool('dynamic', chunk.dynamic)
          .str('title', chunk.title)
          .build();
        await this._core.closeStream(
          chunk.toolCallId,
          { name: TOOL_INPUT_WIRE_NAME, data: '' },
          { headers: { ...options?.headers, ...headers } },
        );
        return;
      }
      case 'tool-input-error': {
        // Close the input stream and mark it as an error via
        // `x-domain-errorText`; the decoder discriminates on that header
        // to emit `tool-input-error` instead of `tool-input-available`.
        const headers = headerWriter()
          .str('toolName', chunk.toolName)
          .json('input', chunk.input)
          .str('errorText', chunk.errorText)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .bool('dynamic', chunk.dynamic)
          .str('title', chunk.title)
          .build();
        await this._core.closeStream(
          chunk.toolCallId,
          { name: TOOL_INPUT_WIRE_NAME, data: '' },
          { headers: { ...options?.headers, ...headers } },
        );
        return;
      }
      case 'tool-output-available': {
        // Discrete wire — the tool-output is independent of the streamed
        // tool-input that opened the part. Receivers correlate to the
        // existing tool part by `toolCallId`. The output is shipped as
        // wire data (Ably handles JSON serialisation of complex
        // payloads); chunk metadata travels in domain headers.
        const headers = headerWriter()
          .str('toolCallId', chunk.toolCallId)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .bool('dynamic', chunk.dynamic)
          .bool('preliminary', chunk.preliminary)
          .build();
        await this._core.publish(
          { name: TOOL_OUTPUT_AVAILABLE_WIRE_NAME, data: chunk.output },
          { headers: { ...options?.headers, ...headers } },
        );
        return;
      }
      case 'tool-output-error': {
        const headers = headerWriter()
          .str('toolCallId', chunk.toolCallId)
          .bool('providerExecuted', chunk.providerExecuted)
          .json('providerMetadata', chunk.providerMetadata)
          .bool('dynamic', chunk.dynamic)
          .build();
        await this._core.publish(
          { name: TOOL_OUTPUT_ERROR_WIRE_NAME, data: chunk.errorText },
          { headers: { ...options?.headers, ...headers } },
        );
        return;
      }
      case 'start-step': {
        // No payload — only the SDK headers (`x-ably-msg-id`) on the wire.
        // The decoder translates this back into a `start-step` chunk and
        // the accumulator pushes a `step-start` part onto the message.
        await this._core.publish({ name: STEP_START_WIRE_NAME, data: '' }, { headers: { ...options?.headers } });
        return;
      }
      default: {
        this._logger?.debug('DefaultUIMessageEncoder.encodePart(); dropping out-of-scope chunk', {
          chunkType: chunk.type,
        });
        return;
      }
    }
  }

  async encodeMessage(message: AI.UIMessage, options?: EncodeOptions): Promise<void> {
    this._logger?.trace('DefaultUIMessageEncoder.encodeMessage();', { messageId: message.id });

    const codecHeaders = headerWriter().str('messageId', message.id).build();
    const headers: Record<string, string> = { ...options?.headers, ...codecHeaders };

    const payloads: { name: string; data: unknown }[] = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        payloads.push({ name: 'text', data: part.text });
      }
      // Other part types (file, data-*, reasoning, etc.) are deferred to
      // follow-up phases — silently dropped here.
    }

    // Defensive fallback — a UIMessage with no encodable text parts still
    // needs a wire so the writer's lastMessageId accounting has something
    // to attribute to.
    if (payloads.length === 0) {
      this._logger?.debug('DefaultUIMessageEncoder.encodeMessage(); no text parts — emitting empty defensive wire', {
        messageId: message.id,
      });
      payloads.push({ name: 'text', data: '' });
    }

    await this._core.publishBatch(payloads, { headers });
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- intentional rejected-promise factory; no async work to await.
  encodeEvent(event: AI.ToolModelMessage, options?: EncodeEventOptions): Promise<void> {
    void event;
    this._logger?.trace('DefaultUIMessageEncoder.encodeEvent();', { messageId: options?.messageId });
    return Promise.reject(
      new Ably.ErrorInfo(
        'unable to encode event; HITL events are not supported in this phase',
        ErrorCode.InvalidArgument,
        400,
      ),
    );
  }

  async close(): Promise<void> {
    this._logger?.trace('DefaultUIMessageEncoder.close();');
    await this._core.close();
  }
}

/**
 * Construct a Vercel codec encoder bound to the supplied core.
 * @param args Encoder wiring; see {@link CreateEncoderArgs}.
 * @returns A new encoder.
 */
export const createEncoder = (args: CreateEncoderArgs): Encoder<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> =>
  new DefaultUIMessageEncoder(args);
