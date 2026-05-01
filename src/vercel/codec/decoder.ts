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

class DefaultUIMessageDecoder implements Decoder<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> {
  private readonly _core: DecoderCore<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>;

  constructor(logger?: Logger) {
    const scoped = logger?.withContext({ component: 'UIMessageDecoder' });
    const hooks: DecoderCoreHooks<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> = {
      buildStartEvents: (tracker) => this._buildStartEvents(scoped, tracker),
      buildDeltaEvents: (tracker, delta) => this._buildDeltaEvents(tracker, delta),
      buildEndEvents: (tracker) => this._buildEndEvents(tracker),
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
    if (tracker.name !== 'text') {
      logger?.debug('UIMessageDecoder.buildStartEvents(); dropping out-of-scope stream', { name: tracker.name });
      return [];
    }
    return [{ kind: 'part', part: { type: 'text-start', id: tracker.streamId } }];
  }

  private _buildDeltaEvents(
    tracker: StreamTrackerState,
    delta: string,
  ): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    if (tracker.name !== 'text') {
      return [];
    }
    return [{ kind: 'part', part: { type: 'text-delta', id: tracker.streamId, delta } }];
  }

  private _buildEndEvents(
    tracker: StreamTrackerState,
  ): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    if (tracker.name !== 'text') {
      return [];
    }
    return [{ kind: 'part', part: { type: 'text-end', id: tracker.streamId } }];
  }

  private _decodeDiscrete(
    logger: Logger | undefined,
    input: { name: string; data: unknown; headers: Record<string, string> },
  ): DecodedValue<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>[] {
    if (input.name !== 'text' || input.headers[Headers.Discrete] !== 'true') {
      logger?.debug('UIMessageDecoder.decodeDiscrete(); dropping out-of-scope wire', { name: input.name });
      return [];
    }

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
}

/**
 * Construct a Vercel codec decoder.
 * @param logger Optional logger inherited from the session.
 * @returns A new decoder.
 */
export const createDecoder = (logger?: Logger): Decoder<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> =>
  new DefaultUIMessageDecoder(logger);
