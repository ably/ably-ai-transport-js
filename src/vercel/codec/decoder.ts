import type * as Ably from 'ably';
import type * as AI from 'ai';

import type {
  DecodedValue,
  Decoder,
  DecoderCore,
  DecoderCoreHooks,
  StreamTrackerState,
} from '../../core/codec/index.js';
import { createDecoderCore, headerReader } from '../../core/codec/index.js';
import { Headers } from '../../headers.js';
import type { Logger } from '../../logger.js';

/** Wire message name carrying a streamed tool-input. Mirrors the encoder. */
const TOOL_INPUT_WIRE_NAME = 'tool-input';

/** Discrete wire name for `tool-output-available` chunks. */
const TOOL_OUTPUT_AVAILABLE_WIRE_NAME = 'tool-output-available';

/** Discrete wire name for `tool-output-error` chunks. */
const TOOL_OUTPUT_ERROR_WIRE_NAME = 'tool-output-error';

/**
 * Type assertion helper for `ProviderMetadata` values pulled from domain
 * headers. The header reader returns `unknown` because JSON values are
 * wire data; the AI SDK declares `providerMetadata` as a typed record
 * shape, so callers narrow at the boundary.
 * @param value JSON-parsed value read from a domain header.
 * @returns The narrowed `AI.ProviderMetadata`, or `undefined` when the
 *   header was absent.
 */
const asProviderMetadata = (value: unknown): AI.ProviderMetadata | undefined => {
  if (value === undefined) return undefined;
  // CAST: `value` is wire data parsed from a domain header; the encoder
  // serialised an `AI.ProviderMetadata` and we trust the round-trip.
  // Runtime structural validation is YAGNI for an internal codec wire.
  return value as AI.ProviderMetadata;
};

class DefaultUIMessageDecoder implements Decoder<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> {
  private readonly _core: DecoderCore<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>;

  constructor(logger?: Logger) {
    const scoped = logger?.withContext({ component: 'UIMessageDecoder' });
    const hooks: DecoderCoreHooks<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> = {
      buildStartEvents: (tracker) => this._buildStartEvents(scoped, tracker),
      buildDeltaEvents: (tracker, delta) => this._buildDeltaEvents(tracker, delta),
      buildEndEvents: (tracker, closingHeaders) => this._buildEndEvents(scoped, tracker, closingHeaders),
      decodeDiscrete: (input) => this._decodeDiscrete(scoped, input),
    };
    this._core = createDecoderCore<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>(hooks, { logger });
  }

  decode(message: Ably.InboundMessage): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    return this._core.decode(message);
  }

  private _buildStartEvents(
    logger: Logger | undefined,
    tracker: StreamTrackerState,
  ): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    if (tracker.name === 'text') {
      return [{ kind: 'part', part: { type: 'text-start', id: tracker.streamId } }];
    }
    if (tracker.name === TOOL_INPUT_WIRE_NAME) {
      const r = headerReader(tracker.headers);
      const toolName = r.str('toolName');
      if (toolName === undefined) {
        logger?.warn('UIMessageDecoder.buildStartEvents(); tool-input stream missing toolName', {
          streamId: tracker.streamId,
        });
        return [];
      }
      const part: AI.UIMessageChunk = {
        type: 'tool-input-start',
        toolCallId: tracker.streamId,
        toolName,
        providerExecuted: r.bool('providerExecuted'),
        providerMetadata: asProviderMetadata(r.json('providerMetadata')),
        dynamic: r.bool('dynamic'),
        title: r.str('title'),
      };
      return [{ kind: 'part', part }];
    }
    logger?.debug('UIMessageDecoder.buildStartEvents(); dropping out-of-scope stream', { name: tracker.name });
    return [];
  }

  private _buildDeltaEvents(
    tracker: StreamTrackerState,
    delta: string,
  ): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    if (tracker.name === 'text') {
      return [{ kind: 'part', part: { type: 'text-delta', id: tracker.streamId, delta } }];
    }
    if (tracker.name === TOOL_INPUT_WIRE_NAME) {
      return [
        {
          kind: 'part',
          part: { type: 'tool-input-delta', toolCallId: tracker.streamId, inputTextDelta: delta },
        },
      ];
    }
    return [];
  }

  private _buildEndEvents(
    logger: Logger | undefined,
    tracker: StreamTrackerState,
    closingHeaders: Record<string, string>,
  ): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    if (tracker.name === 'text') {
      return [{ kind: 'part', part: { type: 'text-end', id: tracker.streamId } }];
    }
    if (tracker.name === TOOL_INPUT_WIRE_NAME) {
      // Close-time headers are merged from the start's persistent headers
      // (re-applied by the encoder core on every append) and any
      // close-specific headers the encoder stamped (`input`, `errorText`).
      // Read the close wire's view rather than the start tracker so that
      // chunk-level overrides (e.g. an updated `toolName` on `available`)
      // win over start values.
      const r = headerReader(closingHeaders);
      const toolName = r.str('toolName');
      if (toolName === undefined) {
        logger?.warn('UIMessageDecoder.buildEndEvents(); tool-input close missing toolName', {
          streamId: tracker.streamId,
        });
        return [];
      }
      const errorText = r.str('errorText');
      if (errorText !== undefined) {
        const part: AI.UIMessageChunk = {
          type: 'tool-input-error',
          toolCallId: tracker.streamId,
          toolName,
          input: r.json('input'),
          errorText,
          providerExecuted: r.bool('providerExecuted'),
          providerMetadata: asProviderMetadata(r.json('providerMetadata')),
          dynamic: r.bool('dynamic'),
          title: r.str('title'),
        };
        return [{ kind: 'part', part }];
      }
      const part: AI.UIMessageChunk = {
        type: 'tool-input-available',
        toolCallId: tracker.streamId,
        toolName,
        input: r.json('input'),
        providerExecuted: r.bool('providerExecuted'),
        providerMetadata: asProviderMetadata(r.json('providerMetadata')),
        dynamic: r.bool('dynamic'),
        title: r.str('title'),
      };
      return [{ kind: 'part', part }];
    }
    return [];
  }

  private _decodeDiscrete(
    logger: Logger | undefined,
    input: { name: string; data: unknown; headers: Record<string, string> },
  ): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    if (input.name === 'text' && input.headers[Headers.Discrete] === 'true') {
      return this._decodeDiscreteText(input);
    }
    if (input.name === TOOL_OUTPUT_AVAILABLE_WIRE_NAME) {
      return this._decodeToolOutputAvailable(logger, input);
    }
    if (input.name === TOOL_OUTPUT_ERROR_WIRE_NAME) {
      return this._decodeToolOutputError(logger, input);
    }
    logger?.debug('UIMessageDecoder.decodeDiscrete(); dropping out-of-scope wire', { name: input.name });
    return [];
  }

  private _decodeDiscreteText(input: {
    name: string;
    data: unknown;
    headers: Record<string, string>;
  }): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    const r = headerReader(input.headers);
    const domainId = r.str('messageId');
    const wireRole = input.headers[Headers.Role];
    const role: AI.UIMessage['role'] = wireRole === 'assistant' ? 'assistant' : 'user';
    const text = typeof input.data === 'string' ? input.data : '';

    // Reconstruct a complete `UIMessage` carrying just this wire's text
    // part. The accumulator merges multi-wire messages keyed by the
    // SDK's `x-ably-msg-id`; the domain id (when supplied) becomes
    // `UIMessage.id`. When the wire carries no domain id we fall back
    // to a placeholder the accumulator overwrites with the SDK routing
    // id so the assembled message still has a stable id.
    const message: AI.UIMessage = {
      id: domainId ?? '',
      role,
      parts: [{ type: 'text', text }],
    };
    return [{ kind: 'message', message }];
  }

  private _decodeToolOutputAvailable(
    logger: Logger | undefined,
    input: { name: string; data: unknown; headers: Record<string, string> },
  ): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    const r = headerReader(input.headers);
    const toolCallId = r.str('toolCallId');
    if (toolCallId === undefined) {
      logger?.warn('UIMessageDecoder.decodeDiscrete(); tool-output-available missing toolCallId');
      return [];
    }
    const part: AI.UIMessageChunk = {
      type: 'tool-output-available',
      toolCallId,
      output: input.data,
      providerExecuted: r.bool('providerExecuted'),
      providerMetadata: asProviderMetadata(r.json('providerMetadata')),
      dynamic: r.bool('dynamic'),
      preliminary: r.bool('preliminary'),
    };
    return [{ kind: 'part', part }];
  }

  private _decodeToolOutputError(
    logger: Logger | undefined,
    input: { name: string; data: unknown; headers: Record<string, string> },
  ): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    const r = headerReader(input.headers);
    const toolCallId = r.str('toolCallId');
    if (toolCallId === undefined) {
      logger?.warn('UIMessageDecoder.decodeDiscrete(); tool-output-error missing toolCallId');
      return [];
    }
    const errorText = typeof input.data === 'string' ? input.data : '';
    const part: AI.UIMessageChunk = {
      type: 'tool-output-error',
      toolCallId,
      errorText,
      providerExecuted: r.bool('providerExecuted'),
      providerMetadata: asProviderMetadata(r.json('providerMetadata')),
      dynamic: r.bool('dynamic'),
    };
    return [{ kind: 'part', part }];
  }
}

/**
 * Construct a Vercel codec decoder.
 * @param logger Optional logger inherited from the session.
 * @returns A new decoder.
 */
export const createDecoder = (logger?: Logger): Decoder<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> =>
  new DefaultUIMessageDecoder(logger);
