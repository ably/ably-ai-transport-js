import * as Ably from 'ably';
import type * as AI from 'ai';

import type { Accumulator } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';

/**
 * Per-message in-progress state for the text-only accumulator. Tracks
 * the assembled `UIMessage` and an `id → partIndex` map for in-flight
 * text streams so multiple `text-delta` chunks land on the right part.
 */
interface ActiveState {
  message: AI.UIMessage;
  /** Map from text-part stream id to its index in `message.parts`. */
  textParts: Map<string, number>;
}

/**
 * Vercel codec accumulator. Phase 8 only handles the text-only chunk
 * vocabulary and the discrete-message merge path via {@link applyMessage}.
 * Every other chunk type is ignored with a debug log — tools, reasoning,
 * files, source-* parts, and AI SDK lifecycle markers all land in
 * follow-up phases.
 */
class DefaultUIMessageAccumulator implements Accumulator<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> {
  private readonly _logger: Logger | undefined;
  private readonly _states = new Map<string, ActiveState>();

  constructor(logger?: Logger) {
    this._logger = logger?.withContext({ component: 'UIMessageAccumulator' });
  }

  processPart(chunk: AI.UIMessageChunk, messageId?: string): void {
    if (messageId === undefined) {
      this._logger?.warn('DefaultUIMessageAccumulator.processPart(); no messageId');
      return;
    }

    switch (chunk.type) {
      case 'text-start': {
        this._handleTextStart(messageId, chunk.id);
        return;
      }
      case 'text-delta': {
        this._handleTextDelta(messageId, chunk.id, chunk.delta);
        return;
      }
      case 'text-end': {
        // Phase 8 has no end-of-stream metadata to fold in; the part is
        // already assembled by accumulated deltas. No-op.
        return;
      }
      default: {
        this._logger?.debug('DefaultUIMessageAccumulator.processPart(); dropping out-of-scope chunk', {
          chunkType: chunk.type,
        });
        return;
      }
    }
  }

  applyEvent(event: AI.ToolModelMessage, messageId?: string): void {
    void event;
    void messageId;
    throw new Ably.ErrorInfo(
      'unable to apply event; tool and HITL events are not supported in this phase',
      ErrorCode.InvalidArgument,
      400,
    );
  }

  applyMessage(messageId: string, message: AI.UIMessage): void {
    const existing = this._states.get(messageId);
    // The codec emits one decoded `UIMessage` per discrete wire; multiple
    // wires for one logical `UIMessage` (a multi-text-part publish) all
    // share the same SDK routing id. Append the new parts to whatever has
    // already accumulated, refreshing the domain id and role from the
    // latest wire (they're guaranteed identical in practice but the
    // codec doesn't enforce it).
    if (existing) {
      existing.message.parts.push(...message.parts);
      if (message.id !== '') {
        existing.message.id = message.id;
      }
      existing.message.role = message.role;
      return;
    }
    // Use the SDK routing id as a stable fallback when the codec
    // produced no domain id — this keeps `UIMessage.id` non-empty and
    // matches the round-trip property when no caller-supplied id exists.
    const fresh: ActiveState = {
      message: { ...message, id: message.id === '' ? messageId : message.id },
      textParts: new Map(),
    };
    this._states.set(messageId, fresh);
  }

  getMessage(messageId: string): AI.UIMessage | undefined {
    return this._states.get(messageId)?.message;
  }

  setMessage(messageId: string, message: AI.UIMessage): void {
    this._states.set(messageId, { message, textParts: new Map() });
  }

  completeMessage(messageId: string): void {
    const state = this._states.get(messageId);
    if (!state) {
      return;
    }
    state.textParts.clear();
    // Keep the assembled message under `_states` so `getMessage` still
    // returns it after completion — the session re-reads on every
    // notification rather than caching a snapshot.
  }

  private _ensureStreamingState(messageId: string): ActiveState {
    const existing = this._states.get(messageId);
    if (existing) {
      return existing;
    }
    // Default role for the streaming path is `'assistant'`; agent
    // responses don't carry a role chunk. The discrete `view.send` path
    // uses `applyMessage` which sets role explicitly from the wire.
    const fresh: ActiveState = {
      message: { id: messageId, role: 'assistant', parts: [] },
      textParts: new Map(),
    };
    this._states.set(messageId, fresh);
    return fresh;
  }

  private _handleTextStart(messageId: string, partId: string): void {
    const state = this._ensureStreamingState(messageId);
    if (state.textParts.has(partId)) {
      // Duplicate text-start under the same partId is a no-op rather
      // than an error, matching the lenient encode path.
      return;
    }
    state.textParts.set(partId, state.message.parts.length);
    state.message.parts.push({ type: 'text', text: '' });
  }

  private _handleTextDelta(messageId: string, partId: string, delta: string): void {
    const state = this._states.get(messageId);
    if (!state) {
      this._logger?.warn('DefaultUIMessageAccumulator.processPart(); text-delta for unknown messageId', { messageId });
      return;
    }
    const index = state.textParts.get(partId);
    if (index === undefined) {
      this._logger?.warn('DefaultUIMessageAccumulator.processPart(); text-delta for unknown stream', {
        messageId,
        partId,
      });
      return;
    }
    const part = state.message.parts[index];
    if (part?.type !== 'text') {
      this._logger?.warn('DefaultUIMessageAccumulator.processPart(); part at index is not text', { messageId, index });
      return;
    }
    part.text += delta;
  }
}

/**
 * Construct a Vercel codec accumulator.
 * @param logger Optional logger inherited from the session.
 * @returns A new accumulator.
 */
export const createAccumulator = (logger?: Logger): Accumulator<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> =>
  new DefaultUIMessageAccumulator(logger);
