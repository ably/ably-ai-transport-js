/**
 * Type definitions for the Anthropic Agent SDK codec.
 *
 * The codec is parameterized by two types:
 *
 *   Codec<AgentCodecEvent, AgentMessage>
 *
 * - `AgentCodecEvent`: A filtered subset of `SDKMessage` from the Agent SDK,
 *   containing only the conversation-relevant message types. The server pipes
 *   `query()` output through the transport — the encoder handles these types
 *   and ignores operational variants (hooks, auth, config, etc.).
 *
 * - `AgentMessage`: The message types stored in the conversation tree and
 *   rendered in the UI. A union of `SDKAssistantMessage` (assistant responses)
 *   and `SDKUserMessage` (user inputs, including synthetic tool results).
 *
 * Both types re-export from `@anthropic-ai/claude-agent-sdk` as a peer
 * dependency. The filtered subset `AgentCodecEvent` is defined here to
 * keep the encoder's switch statement focused on conversation-relevant types.
 */

import type * as Anthropic from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// TEvent — the streaming event type for the codec
// ---------------------------------------------------------------------------

/**
 * Filtered subset of `SDKMessage` containing only conversation-relevant types.
 *
 * The full `SDKMessage` union has ~24 variants, but most are operational
 * (hooks, auth, config, tasks, etc.) and not relevant to the transport codec.
 * The encoder handles these five types and ignores anything else from the
 * `query()` stream.
 *
 * | Type | Role |
 * |---|---|
 * | `SDKPartialAssistantMessage` | Streaming chunks wrapping `BetaRawMessageStreamEvent` |
 * | `SDKAssistantMessage` | Complete assistant response (non-streaming mode or after streaming completes) |
 * | `SDKUserMessage` | User input, including synthetic tool results in agentic flows |
 * | `SDKResultMessage` | Terminal signal — the query is done |
 * | `SDKToolProgressMessage` | Tool execution progress indicators |
 */
export type AgentCodecEvent =
  | Anthropic.SDKPartialAssistantMessage
  | Anthropic.SDKAssistantMessage
  | Anthropic.SDKUserMessage
  | Anthropic.SDKResultMessage
  | Anthropic.SDKToolProgressMessage;

// ---------------------------------------------------------------------------
// TMessage — the message type stored in the conversation tree
// ---------------------------------------------------------------------------

/**
 * Union message type for the conversation tree.
 *
 * Both variants carry a `type` discriminant field (`"assistant"` or `"user"`)
 * for switching. Unlike Vercel's `UIMessage` (a single type with a `role`
 * field), these are structurally different types:
 *
 * - `SDKAssistantMessage.message` is a `BetaMessage` with content blocks
 * - `SDKUserMessage.message` is a `MessageParam` with a content string/array
 */
export type AgentMessage = Anthropic.SDKAssistantMessage | Anthropic.SDKUserMessage;

// ---------------------------------------------------------------------------
// Shared internal type aliases
// ---------------------------------------------------------------------------

/**
 * The inner event of an `SDKPartialAssistantMessage`. This is a
 * `BetaRawMessageStreamEvent` from the Anthropic SDK — a union of
 * `message_start`, `content_block_start`, `content_block_delta`,
 * `content_block_stop`, `message_delta`, and `message_stop`.
 */
export type StreamEvent = Anthropic.SDKPartialAssistantMessage['event'];

/**
 * The `BetaMessage` type from the Anthropic SDK, extracted via indexed
 * access on `SDKAssistantMessage` to avoid importing it directly from the
 * transitive `@anthropic-ai/sdk` dependency.
 */
export type BetaMessage = Anthropic.SDKAssistantMessage['message'];
