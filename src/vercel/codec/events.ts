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
 * agent-emitted approval request. Folded into the projection so the
 * existing tool-call's UI part transitions to `approved` / `denied`.
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
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

/**
 * Every type of record that flows on the channel for the Vercel codec.
 * Encoded by `Encoder.publish`, decoded by `Decoder.decode`, folded by
 * `UIMessageCodec.fold` into a `VercelProjection`.
 */
export type VercelEvent = AI.UIMessageChunk | UserMessageEvent | ToolApprovalEvent;

// ---------------------------------------------------------------------------
// Projection re-export
// ---------------------------------------------------------------------------

export type { VercelProjection } from './reducer.js';
