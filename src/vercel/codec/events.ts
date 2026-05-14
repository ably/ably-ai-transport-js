/**
 * Vercel codec TEvent union.
 *
 * The Vercel codec's TEvent is wider than `AI.UIMessageChunk` because some
 * record types that flow on the channel (user messages, tool approval
 * responses) have no AI SDK chunk variant. Those records are modelled as
 * codec-local TEvent variants here, each with a `type` discriminator
 * prefixed `ait-` to avoid clashing with future `UIMessageChunk` types.
 *
 * The reducer's switch on `event.type` is the only place that knows the
 * full union; the SDK treats VercelEvent as opaque.
 */

import type * as AI from 'ai';

// ---------------------------------------------------------------------------
// Codec-local TEvent variants
// ---------------------------------------------------------------------------

/**
 * A user-originated message on the wire. Produced by the decoder when a
 * `message.create` arrives with `x-ably-role: user`. Folded into the
 * projection as a `role: 'user'` UIMessage.
 */
export interface UserMessageEvent {
  /** Discriminator. */
  type: 'ait-user-message';
  /** The decoded UIMessage representation of the user's input. */
  message: AI.UIMessage;
}

/**
 * A tool-approval response published by the client in answer to an
 * agent-emitted approval request. Self-contained: `targetMsgId` carries
 * the routing metadata the encoder needs to stamp `HEADER_MSG_ID` so the
 * wire message lands on the original assistant message.
 */
export interface ToolApprovalEvent {
  /** Discriminator. */
  type: 'ait-tool-approval';
  /** Tool call this approval responds to. Matches the original tool-input's `toolCallId`. */
  toolCallId: string;
  /** Whether the user approved the tool execution. */
  approved: boolean;
  /** Optional human-readable reason (typically used on denial). */
  reason?: string;
  /**
   * `x-ably-msg-id` of the assistant message carrying the dynamic-tool
   * part this approval responds to. The encoder stamps `HEADER_MSG_ID` to
   * this value.
   */
  targetMsgId: string;
}

/**
 * A client-executed tool's output, published as a TEvent on the channel
 * targeting the assistant message that issued the tool call. Folded into
 * the projection so the existing dynamic-tool part transitions to
 * `output-available`. The encoder reuses the standard
 * `tool-output-available` wire shape, stamping `HEADER_MSG_ID =
 * targetMsgId`.
 *
 * One wire format, two producers — agent-published tool outputs (from
 * `streamText`'s `tool-output-available` UIMessageChunk on the active run)
 * and client-published tool outputs (this variant, on the suspended run)
 * land identically at the decoder.
 */
export interface ClientToolOutputEvent {
  /** Discriminator. */
  type: 'ait-client-tool-output';
  /** Tool call this output resolves. Matches the original tool-input's `toolCallId`. */
  toolCallId: string;
  /** The tool's output payload. Encoded as the wire `data` field. */
  output: unknown;
  /**
   * `x-ably-msg-id` of the assistant message carrying the dynamic-tool
   * part this output resolves. The encoder stamps `HEADER_MSG_ID` to this
   * value.
   */
  targetMsgId: string;
}

/**
 * A client-executed tool's failure, published as a TEvent on the channel
 * targeting the assistant message that issued the tool call. Mirrors
 * {@link ClientToolOutputEvent} on the error side: the encoder reuses the
 * standard `tool-output-error` wire shape, stamping
 * `HEADER_MSG_ID = targetMsgId`.
 */
export interface ClientToolOutputErrorEvent {
  /** Discriminator. */
  type: 'ait-client-tool-output-error';
  /** Tool call this error resolves. */
  toolCallId: string;
  /** Human-readable error message produced by the client tool. */
  errorText: string;
  /**
   * `x-ably-msg-id` of the assistant message carrying the dynamic-tool
   * part this error resolves. The encoder stamps `HEADER_MSG_ID` to this
   * value.
   */
  targetMsgId: string;
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

/**
 * Every type of record that flows on the channel for the Vercel codec.
 * Encoded by `Encoder.publish`, decoded by `Decoder.decode`, folded by
 * `UIMessageCodec.fold` into a `VercelProjection`.
 */
export type VercelEvent =
  | AI.UIMessageChunk
  | UserMessageEvent
  | ToolApprovalEvent
  | ClientToolOutputEvent
  | ClientToolOutputErrorEvent;

// ---------------------------------------------------------------------------
// Projection re-export
// ---------------------------------------------------------------------------

export type { VercelProjection } from './reducer.js';
