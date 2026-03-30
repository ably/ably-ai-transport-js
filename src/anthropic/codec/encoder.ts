/**
 * Anthropic Agent SDK Encoder
 *
 * Maps AgentCodecEvent events and complete AgentMessage objects to Ably channel
 * operations (publish, appendMessage, updateMessage).
 *
 * Delegates the message append lifecycle (publish, append, close, abort,
 * flush/recover) to the encoder core. This file contains only the
 * Anthropic-specific event-to-operation mapping.
 *
 * Domain-specific headers use the `x-domain-` prefix to distinguish them
 * from transport-level `x-ably-` headers.
 *
 * ## Core operations and domain headers
 *
 * Each AgentCodecEvent maps to one or more encoder core operations. Domain
 * headers are passed to every operation that accepts them — the core handles
 * merging, persistence, and deduplication:
 *
 * - **`startStream`**: Opens a message stream for a content block (text,
 *   tool_use input, thinking). Domain headers become "persistent headers" —
 *   the core repeats them on every subsequent append.
 * - **`appendStream`**: Appends a text/json/thinking delta. Data only, no
 *   headers parameter. The core automatically carries persistent headers
 *   from start.
 * - **`closeStream`**: Closes the stream on `content_block_stop`. Pass all
 *   domain headers from the block — the core merges them on top of persistent
 *   headers.
 * - **`publishDiscrete`**: Publishes a standalone message for lifecycle events
 *   (`message_start`, `message_delta`, `message_stop`), complete messages,
 *   results, and non-streaming content blocks.
 *
 * ## Open block tracking
 *
 * Unlike Vercel where each chunk self-identifies (e.g. `text-delta` carries
 * `chunk.id`), Anthropic's `content_block_delta` and `content_block_stop`
 * only carry an `index`. The encoder tracks open content blocks via
 * `_openBlocks` to map index → streamId on delta/stop events.
 */

import * as Ably from 'ably';

import { HEADER_STATUS } from '../../constants.js';
import type { EncoderCore, EncoderCoreOptions } from '../../core/codec/encoder.js';
import { createEncoderCore } from '../../core/codec/encoder.js';
import type { ChannelWriter, MessagePayload, StreamEncoder, WriteOptions } from '../../core/codec/types.js';
import { ErrorCode } from '../../errors.js';
import { headerWriter } from '../../utils.js';
import type { AgentCodecEvent, AgentMessage, StreamEvent } from './types.js';

/** Metadata for an open content block stream: the Ably message name and stream ID. */
interface OpenBlock {
  name: string;
  streamId: string;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultAgentEncoder implements StreamEncoder<AgentCodecEvent, AgentMessage> {
  private readonly _core: EncoderCore;
  private readonly _openBlocks = new Map<number, OpenBlock>();
  private _aborted = false;

  constructor(writer: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._core = createEncoderCore(writer, options);
  }

  async appendEvent(event: AgentCodecEvent, perWrite?: WriteOptions): Promise<void> {
    switch (event.type) {
      // -- Streaming: SDKPartialAssistantMessage wraps BetaRawMessageStreamEvent
      case 'stream_event': {
        await this._handleStreamEvent(event.event, perWrite);
        break;
      }

      // -- Complete assistant message (non-streaming or post-stream)
      case 'assistant': {
        const messageId = event.message.id;
        const h = headerWriter()
          .str('messageId', messageId)
          .str('uuid', event.uuid)
          .str('sessionId', event.session_id)
          .str('parentToolUseId', event.parent_tool_use_id ?? undefined)
          .build();
        await this._core.publishDiscrete({ name: 'assistant-message', data: event.message, headers: h }, perWrite);
        break;
      }

      // -- User message (including synthetic tool results)
      case 'user': {
        const h = headerWriter()
          .str('uuid', event.uuid)
          .str('sessionId', event.session_id)
          .str('parentToolUseId', event.parent_tool_use_id ?? undefined)
          .bool('isSynthetic', event.isSynthetic)
          .build();
        await this._core.publishDiscrete({ name: 'user-message', data: event.message, headers: h }, perWrite);
        break;
      }

      // -- Terminal result signal
      case 'result': {
        const h = headerWriter().str('subtype', event.subtype).build();
        await this._core.publishDiscrete({ name: 'result', data: event, headers: h }, perWrite);
        break;
      }

      // -- Tool execution progress
      case 'tool_progress': {
        await this._core.publishDiscrete({ name: 'tool-progress', data: event }, perWrite);
        break;
      }

      // -- Unknown event types: no-op
      default: {
        break;
      }
    }
  }

  async writeEvent(event: AgentCodecEvent, perWrite?: WriteOptions): Promise<Ably.PublishResult> {
    if (event.type === 'result') {
      const h = headerWriter().str('subtype', event.subtype).build();
      return this._core.publishDiscrete({ name: 'result', data: event, headers: h }, perWrite);
    }

    if (event.type === 'tool_progress') {
      return this._core.publishDiscrete({ name: 'tool-progress', data: event }, perWrite);
    }

    throw new Ably.ErrorInfo(
      `unable to write event; only 'result' and 'tool_progress' types are supported as discrete events, got '${event.type}'`,
      ErrorCode.InvalidArgument,
      400,
    );
  }

  async writeMessages(messages: AgentMessage[], perWrite?: WriteOptions): Promise<Ably.PublishResult> {
    const payloads = messages.map((msg) => encodeMessagePayload(msg));
    return this._core.publishDiscreteBatch(payloads, perWrite);
  }

  async abort(reason?: string): Promise<void> {
    if (this._aborted) return;
    this._aborted = true;
    await this._core.abortAllStreams();
    await this._core.publishDiscrete({
      name: 'abort',
      data: reason ?? '',
      headers: { [HEADER_STATUS]: 'aborted' },
    });
  }

  async close(): Promise<void> {
    await this._core.close();
  }

  // -------------------------------------------------------------------------
  // Private: stream event routing
  // -------------------------------------------------------------------------

  // CAST: StreamEvent is BetaRawMessageStreamEvent — a union of many event shapes.
  // We cast through unknown to access fields after switching on .type, rather than
  // exhaustively narrowing every union member.
  private async _handleStreamEvent(streamEvent: StreamEvent, perWrite?: WriteOptions): Promise<void> {
    const eventType = streamEvent.type as string;

    switch (eventType) {
      case 'message_start': {
        // CAST: message_start carries .message; cast through unknown to Record.
        const message = (streamEvent as unknown as Record<string, unknown>).message as Record<string, unknown>;

        const h = headerWriter()
          .str('messageId', message.id as string)
          .str('model', message.model as string)
          .build();
        await this._core.publishDiscrete({ name: 'message-start', data: message, headers: h }, perWrite);
        break;
      }

      case 'content_block_start': {
        // CAST: content_block_start carries .index and .content_block; cast through unknown.
        const { index, content_block } = streamEvent as unknown as {
          index: number;
          content_block: Record<string, unknown>;
        };
        await this._handleContentBlockStart(index, content_block, perWrite);
        break;
      }

      case 'content_block_delta': {
        // CAST: content_block_delta carries .index and .delta; cast through unknown.
        const { index, delta } = streamEvent as unknown as { index: number; delta: Record<string, unknown> };
        this._handleContentBlockDelta(index, delta);
        break;
      }

      case 'content_block_stop': {
        // CAST: content_block_stop carries .index; cast through unknown.
        const { index } = streamEvent as unknown as { index: number };
        await this._handleContentBlockStop(index);
        break;
      }

      case 'message_delta': {
        // CAST: message_delta carries .delta and .usage; cast through unknown.
        const { delta, usage } = streamEvent as unknown as {
          delta: { stop_reason?: string };
          usage: Record<string, unknown>;
        };
        const h = headerWriter()
          .str('stopReason', delta.stop_reason ?? undefined)
          .build();
        await this._core.publishDiscrete(
          { name: 'message-delta', data: { stop_reason: delta.stop_reason, usage }, headers: h },
          perWrite,
        );
        break;
      }

      case 'message_stop': {
        await this._core.publishDiscrete({ name: 'message-stop', data: '' }, perWrite);
        break;
      }

      default: {
        break;
      }
    }
  }

  // Content block and delta parameters are Record<string, unknown> because the
  // caller casts the union-typed fields through unknown. Property accesses rely on
  // the Anthropic streaming protocol's documented structure — each variant carries
  // a `type` discriminant and known payload fields.

  private async _handleContentBlockStart(
    index: number,
    contentBlock: Record<string, unknown>,
    perWrite?: WriteOptions,
  ): Promise<void> {
    // CAST: content_block.type is always a string discriminant per the Anthropic wire protocol.
    const blockType = contentBlock.type as string;
    const streamId = String(index);

    switch (blockType) {
      case 'text': {
        const h = headerWriter().str('blockIndex', streamId).str('blockType', blockType).build();
        await this._core.startStream(streamId, { name: 'text', data: '', headers: h }, perWrite);
        this._openBlocks.set(index, { name: 'text', streamId });
        break;
      }

      case 'tool_use': {
        // CAST: tool_use content blocks carry string `id` and `name` per the Anthropic protocol.
        const h = headerWriter()
          .str('blockIndex', streamId)
          .str('blockType', blockType)
          .str('toolUseId', contentBlock.id as string)
          .str('toolName', contentBlock.name as string)
          .build();
        await this._core.startStream(streamId, { name: 'tool-input', data: '', headers: h }, perWrite);
        this._openBlocks.set(index, { name: 'tool-input', streamId });
        break;
      }

      case 'thinking': {
        const h = headerWriter().str('blockIndex', streamId).str('blockType', blockType).build();
        await this._core.startStream(streamId, { name: 'thinking', data: '', headers: h }, perWrite);
        this._openBlocks.set(index, { name: 'thinking', streamId });
        break;
      }

      // Non-streaming block types (server_tool_use, web_search_tool_result, etc.)
      // arrive complete — publish as a discrete message.
      default: {
        const h = headerWriter().str('blockIndex', streamId).str('blockType', blockType).build();
        await this._core.publishDiscrete({ name: 'content-block', data: contentBlock, headers: h }, perWrite);
        break;
      }
    }
  }

  private _handleContentBlockDelta(index: number, delta: Record<string, unknown>): void {
    const block = this._openBlocks.get(index);
    if (!block) return;

    // CAST: delta.type is always a string discriminant per the Anthropic wire protocol.
    const deltaType = delta.type as string;

    switch (deltaType) {
      case 'text_delta': {
        // CAST: text_delta carries a string `text` field per the Anthropic protocol.
        this._core.appendStream(block.streamId, delta.text as string);
        break;
      }

      case 'input_json_delta': {
        // CAST: input_json_delta carries a string `partial_json` field per the Anthropic protocol.
        this._core.appendStream(block.streamId, delta.partial_json as string);
        break;
      }

      case 'thinking_delta': {
        // CAST: thinking_delta carries a string `thinking` field per the Anthropic protocol.
        this._core.appendStream(block.streamId, delta.thinking as string);
        break;
      }

      // Other delta types (e.g. citations_delta): no-op
      default: {
        break;
      }
    }
  }

  private async _handleContentBlockStop(index: number): Promise<void> {
    const block = this._openBlocks.get(index);
    if (!block) return;

    await this._core.closeStream(block.streamId, { name: block.name, data: '' });
    this._openBlocks.delete(index);
  }
}

// ---------------------------------------------------------------------------
// Message payload encoding (stateless helper)
// ---------------------------------------------------------------------------

const encodeMessagePayload = (message: AgentMessage): MessagePayload => {
  switch (message.type) {
    case 'user': {
      const h = headerWriter()
        .str('uuid', message.uuid)
        .str('sessionId', message.session_id)
        .str('parentToolUseId', message.parent_tool_use_id ?? undefined)
        .bool('isSynthetic', message.isSynthetic)
        .build();
      return { name: 'user-message', data: message.message, headers: h };
    }

    case 'assistant': {
      const msgId = message.message.id;
      const h = headerWriter()
        .str('messageId', msgId)
        .str('uuid', message.uuid)
        .str('sessionId', message.session_id)
        .str('parentToolUseId', message.parent_tool_use_id ?? undefined)
        .build();
      return { name: 'assistant-message', data: message.message, headers: h };
    }
  }
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Anthropic Agent SDK encoder that maps AgentCodecEvent events to
 * Ably channel operations via the encoder core.
 * @param writer - The channel writer to publish messages through.
 * @param options - Encoder configuration (clientId, extras, hooks, logger).
 * @returns A {@link StreamEncoder} for AgentCodecEvent/AgentMessage.
 */
export const createEncoder = (
  writer: ChannelWriter,
  options: EncoderCoreOptions = {},
): StreamEncoder<AgentCodecEvent, AgentMessage> => new DefaultAgentEncoder(writer, options);
