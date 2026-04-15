/**
 * Anthropic Agent SDK Message Accumulator
 *
 * Builds and maintains an AgentMessage[] list from decoder outputs.
 * Implements MessageAccumulator<AgentCodecEvent, AgentMessage>.
 *
 * The accumulator consumes DecoderOutput[] from the decoder and groups
 * streaming events into SDKAssistantMessage objects using lifecycle
 * boundaries (message_start / message_stop). Complete messages (from
 * writeMessages) are inserted directly.
 *
 * Multiple messages can be in-progress concurrently — each is identified
 * by the `messageId` field on DecoderOutput (read from x-ably-msg-id).
 */

import type { UUID } from 'node:crypto';

import type * as Anthropic from '@anthropic-ai/claude-agent-sdk';

import type { DecoderOutput, MessageAccumulator } from '../../core/codec/types.js';
import type { AgentCodecEvent, AgentMessage, BetaMessage, StreamEvent } from './types.js';

/** Status of a content block stream. */
type StreamStatus = 'streaming' | 'finished' | 'aborted';

/** Tracks the type and index of an in-progress content block. */
interface ContentBlockState {
  /** Content block type discriminant. */
  type: string;
  /** Position in the message's content array. */
  index: number;
}

/** Bundled per-message state for an in-progress assistant message. */
interface ActiveMessageState {
  /** The in-progress SDKAssistantMessage being assembled. */
  message: Anthropic.SDKAssistantMessage;
  /** Content blocks being built, keyed by block index. */
  contentBlocks: Map<number, ContentBlockState>;
  /** JSON accumulation buffers for tool_use inputs, keyed by block index. */
  toolInputBuffers: Map<number, string>;
  /** Stream status per block index. */
  streamStatus: Map<number, StreamStatus>;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultAgentAccumulator implements MessageAccumulator<AgentCodecEvent, AgentMessage> {
  private readonly _messageList: AgentMessage[] = [];
  private readonly _activeMessages = new Map<string, ActiveMessageState>();

  get messages(): AgentMessage[] {
    return this._messageList;
  }

  get completedMessages(): AgentMessage[] {
    const activeSet = new Set<AgentMessage>();
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

  processOutputs(outputs: DecoderOutput<AgentCodecEvent, AgentMessage>[]): void {
    for (const output of outputs) {
      if (output.kind === 'message') {
        this._messageList.push(output.message);
      } else if (output.messageId !== undefined) {
        this._processEvent(output.event, output.messageId);
      }
    }
  }

  initMessage(messageId: string, message: AgentMessage): void {
    const existing = this._activeMessages.get(messageId);

    if (existing) {
      // Already active — sync with the externally updated message.
      // Replace the message reference so the accumulator reflects updates
      // (e.g. cross-turn amendments applied to the tree) that happened
      // outside the streaming flow.
      const cloned = structuredClone(message);
      const listIdx = this._messageList.indexOf(existing.message);
      if (cloned.type === 'assistant') {
        existing.message = cloned;
      }
      if (listIdx !== -1) {
        this._messageList[listIdx] = cloned;
      }
      return;
    }

    // Not active — create tracking state from the existing message.
    const cloned = structuredClone(message);

    if (cloned.type === 'assistant') {
      const contentBlocks = new Map<number, ContentBlockState>();
      const streamStatus = new Map<number, StreamStatus>();

      for (let i = 0; i < cloned.message.content.length; i++) {
        // CAST: Content blocks are a union of SDK types; cast through unknown
        // to read the type discriminant.
        const block = cloned.message.content[i] as unknown as Record<string, unknown>;
        contentBlocks.set(i, { type: block.type as string, index: i });
        streamStatus.set(i, 'finished');
      }

      const state: ActiveMessageState = {
        message: cloned,
        contentBlocks,
        toolInputBuffers: new Map(),
        streamStatus,
      };

      this._activeMessages.set(messageId, state);
    }

    // If this message is already in the list (completed previously),
    // replace in-place. Otherwise push as a new entry.
    const existingIdx = this._messageList.findIndex(
      (m) => m === message || this._messageIdentityKey(m) === this._messageIdentityKey(cloned),
    );
    if (existingIdx === -1) {
      this._messageList.push(cloned);
    } else {
      this._messageList[existingIdx] = cloned;
    }
  }

  completeMessage(messageId: string): void {
    this._activeMessages.delete(messageId);
  }

  // Note: This method is not currently called by the core transport. The
  // identity key (uuid ?? session_id) is best-effort — SDKUserMessage.uuid
  // is optional and session_id can be empty. The object-identity check
  // (m === message) handles the common case where the caller holds a
  // reference to the same object already in the list. If this method becomes
  // load-bearing, the interface should be extended to pass x-ably-msg-id.
  updateMessage(message: AgentMessage): void {
    const key = message.uuid ?? message.session_id;

    const idx = this._messageList.findIndex((m) => {
      const mKey = m.uuid ?? m.session_id;
      return m === message || mKey === key;
    });
    if (idx !== -1) {
      this._messageList[idx] = message;
    }
  }

  // -------------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------------

  private _processEvent(event: AgentCodecEvent, messageId: string): void {
    switch (event.type) {
      case 'stream_event': {
        this._processStreamEvent(event.event, messageId, event);
        break;
      }

      case 'assistant': {
        this._processCompleteAssistant(event, messageId);
        break;
      }

      case 'user': {
        this._messageList.push(event);
        break;
      }

      case 'result': {
        // Terminal signal — clean up any active message for this messageId.
        // On abort, the decoder produces a synthetic SDKResultMessage. The
        // active message (if any) should be finalized: mark all streaming
        // blocks as aborted and remove from active tracking.
        const activeState = this._activeMessages.get(messageId);
        if (activeState) {
          for (const [idx, status] of activeState.streamStatus) {
            if (status === 'streaming') {
              activeState.streamStatus.set(idx, 'aborted');
            }
          }
          this._activeMessages.delete(messageId);
        }
        break;
      }

      case 'tool_progress': {
        break;
      }

      default: {
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Complete assistant message
  // -------------------------------------------------------------------------

  private _processCompleteAssistant(event: Anthropic.SDKAssistantMessage, messageId: string): void {
    const activeState = this._activeMessages.get(messageId);
    if (activeState) {
      // Complete message supersedes the in-progress streaming message.
      // Replace it in-place in the message list.
      const idx = this._messageList.indexOf(activeState.message);
      if (idx === -1) {
        this._messageList.push(event);
      } else {
        this._messageList[idx] = event;
      }
      this._activeMessages.delete(messageId);
    } else {
      this._messageList.push(event);
    }
  }

  // -------------------------------------------------------------------------
  // Stream event processing
  // -------------------------------------------------------------------------

  private _processStreamEvent(
    innerEvent: StreamEvent,
    messageId: string,
    outerEvent: Anthropic.SDKPartialAssistantMessage,
  ): void {
    const eventType = innerEvent.type as string;

    switch (eventType) {
      case 'message_start': {
        this._handleMessageStart(innerEvent as Extract<StreamEvent, { type: 'message_start' }>, messageId, outerEvent);
        break;
      }

      case 'content_block_start': {
        this._handleContentBlockStart(innerEvent as Extract<StreamEvent, { type: 'content_block_start' }>, messageId);
        break;
      }

      case 'content_block_delta': {
        this._handleContentBlockDelta(innerEvent as Extract<StreamEvent, { type: 'content_block_delta' }>, messageId);
        break;
      }

      case 'content_block_stop': {
        this._handleContentBlockStop(innerEvent as Extract<StreamEvent, { type: 'content_block_stop' }>, messageId);
        break;
      }

      case 'message_delta': {
        this._handleMessageDelta(innerEvent as Extract<StreamEvent, { type: 'message_delta' }>, messageId);
        break;
      }

      case 'message_stop': {
        this._handleMessageStop(messageId);
        break;
      }

      default: {
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // message_start
  // -------------------------------------------------------------------------

  private _handleMessageStart(
    // CAST: The inner event is narrowed by the switch on .type above.
    // message_start carries a .message field with the initial BetaMessage shell.
    event: Extract<StreamEvent, { type: 'message_start' }>,
    messageId: string,
    outerEvent: Anthropic.SDKPartialAssistantMessage,
  ): void {
    const state: ActiveMessageState = {
      message: {
        type: 'assistant',
        message: event.message,
        parent_tool_use_id: outerEvent.parent_tool_use_id,
        uuid: outerEvent.uuid,
        session_id: outerEvent.session_id,
      },
      contentBlocks: new Map(),
      toolInputBuffers: new Map(),
      streamStatus: new Map(),
    };
    this._activeMessages.set(messageId, state);
    this._messageList.push(state.message);
  }

  // -------------------------------------------------------------------------
  // content_block_start
  // -------------------------------------------------------------------------

  private _handleContentBlockStart(
    event: Extract<StreamEvent, { type: 'content_block_start' }>,
    messageId: string,
  ): void {
    const state = this._ensureActiveMessage(messageId);
    const index: number = event.index;

    // CAST: content_block is a union of many SDK types; cast through unknown to access
    // discriminant fields without exhaustively matching every union member.
    const contentBlock: Record<string, unknown> = event.content_block as unknown as Record<string, unknown>;
    const blockType = contentBlock.type as string;

    const content: BetaMessage['content'] = state.message.message.content;

    switch (blockType) {
      case 'text': {
        content[index] = { type: 'text', text: '' } as BetaMessage['content'][number];
        state.contentBlocks.set(index, { type: 'text', index });
        state.streamStatus.set(index, 'streaming');
        break;
      }

      case 'tool_use': {
        content[index] = {
          type: 'tool_use',
          id: contentBlock.id as string,
          name: contentBlock.name as string,
          input: {},
        } as BetaMessage['content'][number];
        state.contentBlocks.set(index, { type: 'tool_use', index });
        state.toolInputBuffers.set(index, '');
        state.streamStatus.set(index, 'streaming');
        break;
      }

      case 'thinking': {
        content[index] = {
          type: 'thinking',
          thinking: '',
          signature: '',
        } as BetaMessage['content'][number];
        state.contentBlocks.set(index, { type: 'thinking', index });
        state.streamStatus.set(index, 'streaming');
        break;
      }

      default: {
        // Non-streaming block types — push as-is.
        // CAST: contentBlock is Record<string,unknown> from the cast above; re-cast to the
        // content element type since we cannot exhaustively narrow every SDK union member.
        content[index] = contentBlock as unknown as BetaMessage['content'][number];
        state.contentBlocks.set(index, { type: blockType, index });
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // content_block_delta
  // -------------------------------------------------------------------------

  private _handleContentBlockDelta(
    event: Extract<StreamEvent, { type: 'content_block_delta' }>,
    messageId: string,
  ): void {
    const state = this._activeMessages.get(messageId);
    if (!state) return;

    const index: number = event.index;
    const blockState = state.contentBlocks.get(index);
    if (!blockState) return;

    // CAST: delta is a union of many SDK delta types; cast through unknown to access
    // discriminant fields without exhaustively matching every union member.
    const delta = event.delta as unknown as Record<string, unknown>;
    const deltaType = delta.type as string;

    // CAST: Content blocks are a union of SDK types; cast through unknown to access
    // fields by name after switching on the blockState.type discriminant.
    const block = state.message.message.content[index] as unknown as Record<string, unknown> | undefined;
    if (!block) return;

    switch (deltaType) {
      case 'text_delta': {
        if (blockState.type === 'text' && typeof block.text === 'string') {
          block.text += delta.text as string;
        }
        break;
      }

      case 'input_json_delta': {
        const buffer = state.toolInputBuffers.get(index);
        if (buffer !== undefined) {
          const updated = buffer + (delta.partial_json as string);
          state.toolInputBuffers.set(index, updated);

          try {
            // CAST: JSON.parse returns any; unknown is the safe trust-boundary type.
            block.input = JSON.parse(updated) as unknown;
          } catch {
            // Partial JSON — not parseable yet, keep accumulating.
          }
        }
        break;
      }

      case 'thinking_delta': {
        if (blockState.type === 'thinking' && typeof block.thinking === 'string') {
          block.thinking += delta.thinking as string;
        }
        break;
      }

      case 'signature_delta': {
        // Signatures are required on thinking blocks for multi-turn API continuity.
        if (blockState.type === 'thinking' && typeof block.signature === 'string') {
          block.signature += delta.signature as string;
        }
        break;
      }

      // Other delta types (e.g. citations_delta): no-op
      default: {
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // content_block_stop
  // -------------------------------------------------------------------------

  private _handleContentBlockStop(
    event: Extract<StreamEvent, { type: 'content_block_stop' }>,
    messageId: string,
  ): void {
    const state = this._activeMessages.get(messageId);
    if (!state) return;

    const index: number = event.index;
    state.streamStatus.set(index, 'finished');

    // Final JSON parse for tool_use blocks with buffered input.
    const blockState = state.contentBlocks.get(index);
    if (blockState?.type === 'tool_use') {
      const buffer = state.toolInputBuffers.get(index);
      if (buffer !== undefined && buffer.length > 0) {
        // CAST: Content block is a union of SDK types; cast through unknown to access .input.
        const block = state.message.message.content[index] as unknown as Record<string, unknown> | undefined;
        if (block) {
          try {
            // CAST: JSON.parse returns any; unknown is the safe trust-boundary type.
            block.input = JSON.parse(buffer) as unknown;
          } catch {
            // Buffer did not parse — leave input as last successful parse or {}.
          }
        }
      }
      state.toolInputBuffers.delete(index);
    }
  }

  // -------------------------------------------------------------------------
  // message_delta
  // -------------------------------------------------------------------------

  private _handleMessageDelta(event: Extract<StreamEvent, { type: 'message_delta' }>, messageId: string): void {
    const state = this._activeMessages.get(messageId);
    if (!state) return;

    // CAST: delta is typed as BetaRawMessageDeltaEvent.Delta; cast through unknown
    // to access .stop_reason without matching the exact SDK type shape.
    const delta = event.delta as unknown as Record<string, unknown>;
    if (delta.stop_reason !== undefined) {
      // CAST: stop_reason is a string | null on BetaMessage; cast through unknown to set it.
      (state.message.message as unknown as Record<string, unknown>).stop_reason = delta.stop_reason;
    }

    // CAST: usage on message_delta is BetaMessageDeltaUsage (output_tokens only).
    // Merge into the message's usage field. Cast through unknown because
    // BetaMessageDeltaUsage does not have a string index signature.
    const usage = event.usage as unknown as Record<string, unknown> | undefined;
    if (usage !== undefined) {
      // CAST: BetaUsage does not have a string index signature; cast through unknown.
      const msgUsage = state.message.message.usage as unknown as Record<string, unknown>;
      if (typeof usage.output_tokens === 'number') {
        msgUsage.output_tokens = usage.output_tokens;
      }
    }
  }

  // -------------------------------------------------------------------------
  // message_stop
  // -------------------------------------------------------------------------

  private _handleMessageStop(messageId: string): void {
    // Message is already in _messageList (pushed on creation).
    // Just remove from active tracking so completedMessages includes it.
    this._activeMessages.delete(messageId);
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private _messageIdentityKey(message: AgentMessage): string {
    return message.uuid ?? message.session_id;
  }

  private _ensureActiveMessage(messageId: string): ActiveMessageState {
    const existing = this._activeMessages.get(messageId);
    if (existing) return existing;

    // CAST: Defensive creation for mid-stream join — message_start was missed.
    // The accumulator creates a minimal shell that will be updated as more events arrive.

    /* eslint-disable unicorn/no-null -- SDK types use null for absent optional fields */
    const shell: Anthropic.SDKAssistantMessage = {
      type: 'assistant',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: 'unknown',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: null,
          inference_geo: null,
          iterations: null,
          server_tool_use: null,
          service_tier: null,
          speed: null,
        },
        container: null,
        context_management: null,
      } as BetaMessage,
      parent_tool_use_id: null,
      uuid: messageId as UUID,
      session_id: '',
    };
    /* eslint-enable unicorn/no-null */

    const state: ActiveMessageState = {
      message: shell,
      contentBlocks: new Map(),
      toolInputBuffers: new Map(),
      streamStatus: new Map(),
    };
    this._activeMessages.set(messageId, state);
    this._messageList.push(state.message);
    return state;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Anthropic Agent SDK accumulator that builds AgentMessage[] from decoder outputs.
 * @returns A {@link MessageAccumulator} for AgentCodecEvent/AgentMessage.
 */
export const createAccumulator = (): MessageAccumulator<AgentCodecEvent, AgentMessage> => new DefaultAgentAccumulator();
