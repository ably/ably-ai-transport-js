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
 * Vercel encoder. Wraps an {@link EncoderCore} and maps `UIMessageChunk`
 * events plus complete `UIMessage` objects onto the core's primitives.
 *
 * Phase 8 is **text-only**: `encodePart` handles `text-start` /
 * `text-delta` / `text-end`; every other chunk type (lifecycle markers,
 * tool input/output, reasoning, files, source documents, `data-*`,
 * etc.) is silently dropped with a debug log so an agent's
 * `agent.stream(...)` output flows through unchanged — only text deltas
 * reach the wire. Tool support and the rest of the chunk vocabulary
 * land in follow-up phases.
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
        'unable to encode event; tool and HITL events are not supported in this phase',
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
