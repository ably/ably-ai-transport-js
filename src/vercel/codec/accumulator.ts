import * as Ably from 'ably';
import type * as AI from 'ai';

import type { Accumulator } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';

/**
 * Per-message in-progress state for the accumulator. Tracks the assembled
 * `UIMessage`, an `id → partIndex` map for in-flight text streams (so
 * multiple `text-delta` chunks land on the right part), and a
 * `toolCallId → partIndex` map for in-flight tool-input streams (so
 * `tool-input-{delta,available,error}` chunks find the part the
 * `tool-input-start` opened).
 */
interface ActiveState {
  message: AI.UIMessage;
  /** Map from text-part stream id to its index in `message.parts`. */
  textParts: Map<string, number>;
  /** Map from `toolCallId` to the tool part's index in `message.parts`. */
  toolParts: Map<string, number>;
}

/**
 * Common fields a tool-input chunk carries that identify the tool part
 * being built. Used by the accumulator's tool-part construction helper to
 * pick between the static `tool-${toolName}` and dynamic `dynamic-tool`
 * shapes uniformly across the streaming chunk types.
 */
interface ToolPartIdentity {
  toolCallId: string;
  toolName: string;
  providerExecuted?: boolean | undefined;
  providerMetadata?: AI.ProviderMetadata | undefined;
  dynamic?: boolean | undefined;
  title?: string | undefined;
}

/**
 * Build the identity portion of a tool part — the fields shared across
 * every state (input-streaming → input-available → output-* etc.). The
 * AI SDK splits static and dynamic tools into two part shapes:
 * statically-declared tools have `type: 'tool-${toolName}'`; tools whose
 * schema isn't known at compile time have `type: 'dynamic-tool'` and
 * carry `toolName` as a property. The encoder ships `dynamic` as a
 * domain header and the decoder relays it onto every chunk; we branch
 * here so callers don't repeat the discriminator.
 * @param chunk Identity fields decoded from a tool-input chunk.
 * @returns A partial part record with `type` (and `toolName` for dynamic
 *   tools) plus the shared identity fields.
 */
const buildToolPartShell = (chunk: ToolPartIdentity): Record<string, unknown> => {
  if (chunk.dynamic === true) {
    return {
      type: 'dynamic-tool',
      toolName: chunk.toolName,
      toolCallId: chunk.toolCallId,
      title: chunk.title,
      providerExecuted: chunk.providerExecuted,
    };
  }
  return {
    type: `tool-${chunk.toolName}`,
    toolCallId: chunk.toolCallId,
    title: chunk.title,
    providerExecuted: chunk.providerExecuted,
  };
};

/**
 * Vercel codec accumulator. Assembles streamed text and tool-input chunks
 * into `UIMessage` parts; non-text/non-tool-input chunk types (reasoning,
 * files, source-* parts, AI SDK lifecycle markers, tool output) are
 * dropped with a debug log — they land in follow-up phases.
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
        // No end-of-stream metadata to fold in; the part is already
        // assembled by accumulated deltas. No-op.
        return;
      }
      case 'tool-input-start': {
        this._handleToolInputStart(messageId, chunk);
        return;
      }
      case 'tool-input-delta': {
        // Streaming JSON deltas are surfaced through the decoder for any
        // consumer that subscribes to chunks directly, but the assembled
        // `UIMessage.parts[i].input` stays undefined until
        // `tool-input-available` arrives — partial JSON parsing is
        // out-of-scope for the assembler.
        return;
      }
      case 'tool-input-available': {
        this._handleToolInputAvailable(messageId, chunk);
        return;
      }
      case 'tool-input-error': {
        this._handleToolInputError(messageId, chunk);
        return;
      }
      case 'tool-output-available': {
        this._handleToolOutputAvailable(messageId, chunk);
        return;
      }
      case 'tool-output-error': {
        this._handleToolOutputError(messageId, chunk);
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
      'unable to apply event; HITL events are not supported in this phase',
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
      toolParts: new Map(),
    };
    this._states.set(messageId, fresh);
  }

  getMessage(messageId: string): AI.UIMessage | undefined {
    return this._states.get(messageId)?.message;
  }

  setMessage(messageId: string, message: AI.UIMessage): void {
    this._states.set(messageId, { message, textParts: new Map(), toolParts: new Map() });
  }

  completeMessage(messageId: string): void {
    const state = this._states.get(messageId);
    if (!state) {
      return;
    }
    state.textParts.clear();
    state.toolParts.clear();
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
      toolParts: new Map(),
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

  private _handleToolInputStart(
    messageId: string,
    chunk: Extract<AI.UIMessageChunk, { type: 'tool-input-start' }>,
  ): void {
    const state = this._ensureStreamingState(messageId);
    if (state.toolParts.has(chunk.toolCallId)) {
      // Duplicate tool-input-start for the same toolCallId is a no-op,
      // matching the lenient encode path. Real Ably history replay never
      // produces duplicates, but a misbehaving codec consumer might.
      return;
    }
    const part = {
      ...buildToolPartShell(chunk),
      state: 'input-streaming',
      input: undefined,
      callProviderMetadata: chunk.providerMetadata,
    };
    state.toolParts.set(chunk.toolCallId, state.message.parts.length);
    // CAST: the constructed object satisfies the `ToolUIPart` /
    // `DynamicToolUIPart` discriminated unions, but their state-keyed
    // shape is too granular for TS to narrow from a `Record<string, unknown>`
    // shell. Trust the shell builder; the unit tests assert the runtime
    // shape.
    state.message.parts.push(part as AI.UIMessage['parts'][number]);
  }

  private _handleToolInputAvailable(
    messageId: string,
    chunk: Extract<AI.UIMessageChunk, { type: 'tool-input-available' }>,
  ): void {
    const index = this._lookupToolPartIndex(messageId, chunk.toolCallId, 'tool-input-available');
    if (index === undefined) return;
    const state = this._states.get(messageId);
    if (!state) return;
    const part = {
      ...buildToolPartShell(chunk),
      state: 'input-available',
      input: chunk.input,
      callProviderMetadata: chunk.providerMetadata,
    };
    // CAST: see _handleToolInputStart.
    state.message.parts[index] = part as AI.UIMessage['parts'][number];
  }

  private _handleToolInputError(
    messageId: string,
    chunk: Extract<AI.UIMessageChunk, { type: 'tool-input-error' }>,
  ): void {
    const index = this._lookupToolPartIndex(messageId, chunk.toolCallId, 'tool-input-error');
    if (index === undefined) return;
    const state = this._states.get(messageId);
    if (!state) return;
    // The AI SDK encodes input-parsing failures as `state: 'output-error'`
    // (the same terminal state output failures use). `input` is undefined
    // because parsing failed; the unparsed payload — whatever the model
    // produced — surfaces under `rawInput` for debugging UIs.
    const part = {
      ...buildToolPartShell(chunk),
      state: 'output-error',
      input: undefined,
      rawInput: chunk.input,
      errorText: chunk.errorText,
      callProviderMetadata: chunk.providerMetadata,
    };
    // CAST: see _handleToolInputStart.
    state.message.parts[index] = part as AI.UIMessage['parts'][number];
  }

  private _handleToolOutputAvailable(
    messageId: string,
    chunk: Extract<AI.UIMessageChunk, { type: 'tool-output-available' }>,
  ): void {
    const index = this._lookupToolPartIndex(messageId, chunk.toolCallId, 'tool-output-available');
    if (index === undefined) return;
    const state = this._states.get(messageId);
    if (!state) return;
    const existing = state.message.parts[index];
    if (existing === undefined) return;

    // Spread the existing part to preserve identity (type, toolName for
    // dynamic-tool, toolCallId, title, providerExecuted, input,
    // callProviderMetadata) — the output chunk only carries the result
    // payload. The chunk's `providerMetadata` becomes
    // `resultProviderMetadata` on the part (the call-side metadata
    // captured in `_handleToolInputStart` stays under
    // `callProviderMetadata`). We strip `errorText` / `rawInput` defensively
    // in case a prior `output-error` state carried them — output-available
    // declares `errorText?: never`.
    // CAST: existing part is the constructed runtime object from prior
    // state handlers; read it through a permissive shape because
    // discriminated-union narrowing on `AI.UIMessagePart` is too granular
    // for in-place transitions.
    const { errorText: _errorText, rawInput: _rawInput, ...identity } = existing as Record<string, unknown>;
    void _errorText;
    void _rawInput;
    const part = {
      ...identity,
      state: 'output-available',
      output: chunk.output,
      resultProviderMetadata: chunk.providerMetadata,
      preliminary: chunk.preliminary,
    };
    // CAST: see _handleToolInputStart.
    state.message.parts[index] = part as AI.UIMessage['parts'][number];
  }

  private _handleToolOutputError(
    messageId: string,
    chunk: Extract<AI.UIMessageChunk, { type: 'tool-output-error' }>,
  ): void {
    const index = this._lookupToolPartIndex(messageId, chunk.toolCallId, 'tool-output-error');
    if (index === undefined) return;
    const state = this._states.get(messageId);
    if (!state) return;
    const existing = state.message.parts[index];
    if (existing === undefined) return;

    // CAST: see _handleToolOutputAvailable.
    const { output: _output, preliminary: _preliminary, ...identity } = existing as Record<string, unknown>;
    void _output;
    void _preliminary;
    const part = {
      ...identity,
      state: 'output-error',
      errorText: chunk.errorText,
      resultProviderMetadata: chunk.providerMetadata,
    };
    // CAST: see _handleToolInputStart.
    state.message.parts[index] = part as AI.UIMessage['parts'][number];
  }

  private _lookupToolPartIndex(messageId: string, toolCallId: string, source: string): number | undefined {
    const state = this._states.get(messageId);
    if (!state) {
      this._logger?.warn(`DefaultUIMessageAccumulator.processPart(); ${source} for unknown messageId`, {
        messageId,
        toolCallId,
      });
      return undefined;
    }
    const index = state.toolParts.get(toolCallId);
    if (index === undefined) {
      this._logger?.warn(`DefaultUIMessageAccumulator.processPart(); ${source} for unknown toolCallId`, {
        messageId,
        toolCallId,
      });
      return undefined;
    }
    return index;
  }
}

/**
 * Construct a Vercel codec accumulator.
 * @param logger Optional logger inherited from the session.
 * @returns A new accumulator.
 */
export const createAccumulator = (logger?: Logger): Accumulator<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> =>
  new DefaultUIMessageAccumulator(logger);
