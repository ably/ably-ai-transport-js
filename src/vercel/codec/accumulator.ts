/**
 * Vercel AI SDK Message Accumulator
 *
 * Builds and maintains a UIMessage[] list from decoder outputs.
 * Implements MessageAccumulator<UIMessageChunk, UIMessage>.
 *
 * The accumulator consumes DecoderOutput[] from the decoder and groups
 * streaming events into UIMessage objects using lifecycle boundaries
 * (start/finish). Complete messages (from writeMessages) are inserted
 * directly.
 *
 * Multiple messages can be in-progress concurrently — each is identified
 * by the `messageId` field on DecoderOutput (read from x-ably-msg-id).
 */

import type * as AI from 'ai';

import type { DecoderOutput, MessageAccumulator } from '../../core/codec/types.js';
import { stripUndefined } from '../../utils.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Status of a streamed message (text, reasoning, or tool-input). */
type StreamStatus = 'streaming' | 'finished' | 'aborted';

/**
 * Tracks an in-progress tool part's position and accumulated streaming input.
 * Text and reasoning parts don't need this — we write directly to the part.
 * Tool parts need the extra `inputText` buffer because deltas arrive as raw
 * JSON fragments that must be accumulated before parsing.
 */
interface ToolPartTracker {
  /** Index in the message's parts array. */
  partIndex: number;
  /** Accumulated streaming input text (for JSON parsing on completion). */
  inputText: string;
}

/** Fields shared by all DynamicToolUIPart state variants. */
interface ToolBaseFields {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
  title?: string;
  providerExecuted?: boolean;
}

/** Bundled per-message state for an in-progress message. */
interface ActiveMessageState {
  message: AI.UIMessage;
  textStreams: DeltaStreamTracker;
  reasoningStreams: DeltaStreamTracker;
  toolTrackers: Record<string, ToolPartTracker>;
  streamStatus: Map<string, StreamStatus>;
}

// ---------------------------------------------------------------------------
// Tool base helper
// ---------------------------------------------------------------------------

/**
 * Extract the state-independent base fields for a DynamicToolUIPart.
 * Works with both chunks (tool-input-start, etc.) and existing parts.
 * @param source - Any object containing the required tool identity fields.
 * @param source.toolCallId - The tool call identifier.
 * @param source.toolName - The tool name.
 * @param source.title - Optional display title.
 * @param source.providerExecuted - Whether the provider executed the tool.
 * @returns Base fields shared across all DynamicToolUIPart state variants.
 */
const toolBase = (source: {
  toolCallId: string;
  toolName: string;
  title?: string;
  providerExecuted?: boolean;
}): ToolBaseFields =>
  stripUndefined({
    type: 'dynamic-tool' as const,
    toolCallId: source.toolCallId,
    toolName: source.toolName,
    title: source.title,
    providerExecuted: source.providerExecuted,
  });

// ---------------------------------------------------------------------------
// DeltaStreamTracker — manages text or reasoning stream accumulation
// ---------------------------------------------------------------------------

/**
 * Tracks in-progress text or reasoning streams within a single message.
 * Owns the mapping from stream ID to part index, enforcing the pairing
 * of part type and index map by construction.
 */
class DeltaStreamTracker {
  private readonly _partType: 'text' | 'reasoning';
  private _activeIndex = new Map<string, number>();

  constructor(partType: 'text' | 'reasoning') {
    this._partType = partType;
  }

  start(id: string, msg: AI.UIMessage, streamStatus: Map<string, StreamStatus>): void {
    this._activeIndex.set(id, msg.parts.length);
    msg.parts.push({ type: this._partType, text: '' });
    streamStatus.set(id, 'streaming');
  }

  delta(id: string, msg: AI.UIMessage, text: string): void {
    const idx = this._activeIndex.get(id);
    if (idx === undefined) return;
    const part = msg.parts[idx];
    if (part?.type === this._partType) {
      part.text += text;
    }
  }

  end(id: string, streamStatus: Map<string, StreamStatus>): void {
    streamStatus.set(id, 'finished');
    this._activeIndex.delete(id);
  }

  reset(): void {
    this._activeIndex = new Map();
  }
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultUIMessageAccumulator implements MessageAccumulator<AI.UIMessageChunk, AI.UIMessage> {
  private readonly _messageList: AI.UIMessage[] = [];
  private readonly _activeMessages = new Map<string, ActiveMessageState>();

  get messages(): AI.UIMessage[] {
    return this._messageList;
  }

  get completedMessages(): AI.UIMessage[] {
    const activeSet = new Set<AI.UIMessage>();
    for (const state of this._activeMessages.values()) {
      activeSet.add(state.message);
    }
    return this._messageList.filter((msg) => !activeSet.has(msg));
  }

  get hasActiveStream(): boolean {
    for (const state of this._activeMessages.values()) {
      for (const status of state.streamStatus.values()) {
        if (status === 'streaming') return true;
      }
    }
    return false;
  }

  processOutputs(outputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[]): void {
    for (const output of outputs) {
      if (output.kind === 'message') {
        this._messageList.push(output.message);
      } else if (output.messageId !== undefined) {
        this._processEvent(output.event, output.messageId);
      }
    }
  }

  updateMessage(message: AI.UIMessage): void {
    const idx = this._messageList.findIndex((m) => m.id === message.id);
    if (idx !== -1) {
      this._messageList[idx] = message;
    }
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private _ensureActiveMessage(messageId: string): ActiveMessageState {
    const existing = this._activeMessages.get(messageId);
    if (existing) return existing;

    const state: ActiveMessageState = {
      message: { id: messageId, role: 'assistant', parts: [] },
      textStreams: new DeltaStreamTracker('text'),
      reasoningStreams: new DeltaStreamTracker('reasoning'),
      toolTrackers: {},
      streamStatus: new Map(),
    };
    this._activeMessages.set(messageId, state);
    this._messageList.push(state.message);
    return state;
  }

  /**
   * Look up a tracked tool part by toolCallId within a message state.
   * @param toolCallId - The tool call identifier to look up.
   * @param state - The active message state to search in.
   * @returns The tracker and current part, or undefined if not found.
   */
  private _getToolPart(
    toolCallId: string,
    state: ActiveMessageState,
  ): { tracker: ToolPartTracker; part: AI.DynamicToolUIPart } | undefined {
    const tracker = state.toolTrackers[toolCallId];
    if (!tracker) return undefined;

    const existing = state.message.parts[tracker.partIndex];
    if (existing?.type !== 'dynamic-tool') return undefined;

    return { tracker, part: existing };
  }

  // -------------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------------

  private _processEvent(chunk: AI.UIMessageChunk, messageId: string): void {
    switch (chunk.type) {
      case 'start':
      case 'start-step':
      case 'finish-step':
      case 'finish':
      case 'abort':
      case 'error':
      case 'message-metadata': {
        this._processLifecycle(chunk, messageId);
        break;
      }

      case 'text-start':
      case 'text-delta':
      case 'text-end':
      case 'reasoning-start':
      case 'reasoning-delta':
      case 'reasoning-end': {
        this._processTextOrReasoning(chunk, messageId);
        break;
      }

      case 'tool-input-start':
      case 'tool-input-delta':
      case 'tool-input-available':
      case 'tool-input-error': {
        this._processToolInput(chunk, messageId);
        break;
      }

      case 'tool-output-available':
      case 'tool-output-error':
      case 'tool-output-denied':
      case 'tool-approval-request': {
        this._processToolOutput(chunk, messageId);
        break;
      }

      case 'file':
      case 'source-url':
      case 'source-document': {
        this._processContentPart(chunk, messageId);
        break;
      }

      default: {
        if (chunk.type.startsWith('data-')) {
          if (chunk.transient) break;

          const state = this._ensureActiveMessage(messageId);

          // CAST: chunk.type is `data-${string}` which satisfies DataUIPart,
          // but TypeScript cannot verify the template literal matches a
          // specific UIMessagePart variant at the type level.
          const dataPart = stripUndefined({
            type: chunk.type,
            id: chunk.id,
            data: chunk.data,
          }) as AI.UIMessage['parts'][number];

          if (chunk.id !== undefined) {
            const idx = state.message.parts.findIndex((p) => p.type === chunk.type && 'id' in p && p.id === chunk.id);
            if (idx !== -1) {
              state.message.parts[idx] = dataPart;
              break;
            }
          }

          state.message.parts.push(dataPart);
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle events
  // -------------------------------------------------------------------------

  private _processLifecycle(
    chunk: Extract<
      AI.UIMessageChunk,
      { type: 'start' | 'start-step' | 'finish-step' | 'finish' | 'abort' | 'error' | 'message-metadata' }
    >,
    messageId: string,
  ): void {
    switch (chunk.type) {
      case 'start': {
        const state = this._ensureActiveMessage(messageId);
        if (chunk.messageId) state.message.id = chunk.messageId;
        if (chunk.messageMetadata !== undefined) {
          state.message.metadata = chunk.messageMetadata;
        }
        break;
      }

      case 'start-step': {
        const state = this._ensureActiveMessage(messageId);
        state.message.parts.push({ type: 'step-start' });
        break;
      }

      case 'finish-step': {
        const state = this._activeMessages.get(messageId);
        if (state) {
          state.textStreams.reset();
          state.reasoningStreams.reset();
        }
        break;
      }

      case 'finish': {
        const state = this._activeMessages.get(messageId);
        if (state && chunk.messageMetadata !== undefined) {
          state.message.metadata = chunk.messageMetadata;
        }
        this._activeMessages.delete(messageId);
        break;
      }

      case 'abort': {
        const state = this._activeMessages.get(messageId);
        if (state) {
          for (const [id, status] of state.streamStatus) {
            if (status === 'streaming') {
              state.streamStatus.set(id, 'aborted');
            }
          }
        }
        this._activeMessages.delete(messageId);
        break;
      }

      case 'error': {
        break;
      }

      case 'message-metadata': {
        const state = this._activeMessages.get(messageId);
        if (state && chunk.messageMetadata !== undefined) {
          state.message.metadata = chunk.messageMetadata;
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Text and reasoning streaming
  // -------------------------------------------------------------------------

  private _processTextOrReasoning(
    chunk: Extract<
      AI.UIMessageChunk,
      { type: 'text-start' | 'text-delta' | 'text-end' | 'reasoning-start' | 'reasoning-delta' | 'reasoning-end' }
    >,
    messageId: string,
  ): void {
    const state = this._ensureActiveMessage(messageId);

    switch (chunk.type) {
      case 'text-start': {
        state.textStreams.start(chunk.id, state.message, state.streamStatus);
        break;
      }
      case 'text-delta': {
        state.textStreams.delta(chunk.id, state.message, chunk.delta);
        break;
      }
      case 'text-end': {
        state.textStreams.end(chunk.id, state.streamStatus);
        break;
      }
      case 'reasoning-start': {
        state.reasoningStreams.start(chunk.id, state.message, state.streamStatus);
        break;
      }
      case 'reasoning-delta': {
        state.reasoningStreams.delta(chunk.id, state.message, chunk.delta);
        break;
      }
      case 'reasoning-end': {
        state.reasoningStreams.end(chunk.id, state.streamStatus);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tool input streaming
  // -------------------------------------------------------------------------

  private _processToolInput(
    chunk: Extract<
      AI.UIMessageChunk,
      { type: 'tool-input-start' | 'tool-input-delta' | 'tool-input-available' | 'tool-input-error' }
    >,
    messageId: string,
  ): void {
    switch (chunk.type) {
      case 'tool-input-start': {
        const state = this._ensureActiveMessage(messageId);
        const partIndex = state.message.parts.length;
        state.message.parts.push({ ...toolBase(chunk), state: 'input-streaming', input: undefined });
        state.toolTrackers[chunk.toolCallId] = { partIndex, inputText: '' };
        state.streamStatus.set(chunk.toolCallId, 'streaming');
        break;
      }

      case 'tool-input-delta': {
        const state = this._ensureActiveMessage(messageId);
        const tracker = state.toolTrackers[chunk.toolCallId];
        if (!tracker) break;
        tracker.inputText += chunk.inputTextDelta;

        let parsedInput: unknown;
        try {
          // CAST: JSON.parse returns any; unknown is the safe trust-boundary type.
          parsedInput = JSON.parse(tracker.inputText) as unknown;
        } catch {
          parsedInput = undefined;
        }

        const found = this._getToolPart(chunk.toolCallId, state);
        if (!found) break;
        state.message.parts[found.tracker.partIndex] = {
          ...toolBase(found.part),
          state: 'input-streaming',
          input: parsedInput,
        };
        break;
      }

      case 'tool-input-available': {
        const state = this._ensureActiveMessage(messageId);
        const found = this._getToolPart(chunk.toolCallId, state);
        if (!found) break;
        state.message.parts[found.tracker.partIndex] = {
          ...toolBase(found.part),
          state: 'input-available',
          input: chunk.input,
        };
        state.streamStatus.set(chunk.toolCallId, 'finished');
        break;
      }

      case 'tool-input-error': {
        const state = this._ensureActiveMessage(messageId);
        const found = this._getToolPart(chunk.toolCallId, state);
        if (found) {
          state.message.parts[found.tracker.partIndex] = {
            ...toolBase(found.part),
            state: 'output-error',
            input: chunk.input,
            errorText: chunk.errorText,
          };
        } else {
          const partIndex = state.message.parts.length;
          state.message.parts.push({
            ...toolBase(chunk),
            state: 'output-error',
            input: chunk.input,
            errorText: chunk.errorText,
          });
          state.toolTrackers[chunk.toolCallId] = { partIndex, inputText: '' };
        }
        state.streamStatus.set(chunk.toolCallId, 'finished');
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tool output transitions
  // -------------------------------------------------------------------------

  private _processToolOutput(
    chunk: Extract<
      AI.UIMessageChunk,
      { type: 'tool-output-available' | 'tool-output-error' | 'tool-output-denied' | 'tool-approval-request' }
    >,
    messageId: string,
  ): void {
    const state = this._ensureActiveMessage(messageId);
    const found = this._getToolPart(chunk.toolCallId, state);
    if (!found) return;

    switch (chunk.type) {
      case 'tool-output-available': {
        state.message.parts[found.tracker.partIndex] = stripUndefined({
          ...toolBase(found.part),
          state: 'output-available' as const,
          input: found.part.input,
          output: chunk.output,
          preliminary: chunk.preliminary,
        });
        break;
      }

      case 'tool-output-error': {
        state.message.parts[found.tracker.partIndex] = {
          ...toolBase(found.part),
          state: 'output-error',
          input: found.part.input,
          errorText: chunk.errorText,
        };
        break;
      }

      case 'tool-output-denied': {
        state.message.parts[found.tracker.partIndex] = {
          ...toolBase(found.part),
          state: 'output-denied',
          input: found.part.input,
          approval: { id: '', approved: false },
        };
        break;
      }

      case 'tool-approval-request': {
        state.message.parts[found.tracker.partIndex] = {
          ...toolBase(found.part),
          state: 'approval-requested',
          input: found.part.input,
          approval: { id: chunk.approvalId },
        };
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Content parts
  // -------------------------------------------------------------------------

  private _processContentPart(
    chunk: Extract<AI.UIMessageChunk, { type: 'file' | 'source-url' | 'source-document' }>,
    messageId: string,
  ): void {
    const state = this._ensureActiveMessage(messageId);

    switch (chunk.type) {
      case 'file': {
        state.message.parts.push({ type: 'file', mediaType: chunk.mediaType, url: chunk.url });
        break;
      }

      case 'source-url': {
        state.message.parts.push(
          stripUndefined({
            type: 'source-url' as const,
            sourceId: chunk.sourceId,
            url: chunk.url,
            title: chunk.title,
          }),
        );
        break;
      }

      case 'source-document': {
        state.message.parts.push(
          stripUndefined({
            type: 'source-document' as const,
            sourceId: chunk.sourceId,
            mediaType: chunk.mediaType,
            title: chunk.title,
            filename: chunk.filename,
          }),
        );
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel AI SDK accumulator that builds UIMessage[] from decoder outputs.
 * @returns A {@link MessageAccumulator} for UIMessageChunk/UIMessage.
 */
export const createAccumulator = (): MessageAccumulator<AI.UIMessageChunk, AI.UIMessage> =>
  new DefaultUIMessageAccumulator();
