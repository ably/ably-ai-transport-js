/**
 * Vercel codec TEvent union.
 *
 * The Vercel codec's TEvent is wider than `AI.UIMessageChunk` because some
 * record types that flow on the channel (user messages, tool-approval
 * responses) have no AI SDK chunk variant. Those records are modelled as
 * codec-local TEvent variants here, each with a `type` discriminator
 * prefixed `ait-` (or, for AI-SDK-symmetric names like
 * `tool-approval-response`, mirroring the wire-message name).
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
 * projection as a `role: 'user'` UIMessage — except when the message's
 * parts encode a tool resolution (output/approval), in which case the
 * reducer redirects the fold onto the prior assistant by `toolCallId`
 * and marks the user-message as consumed (suppressed from `getMessages`).
 */
export interface UserMessageEvent {
  /** Discriminator. */
  type: 'ait-user-message';
  /** The decoded UIMessage representation of the user's input. */
  message: AI.UIMessage;
}

/**
 * A client-published tool-approval response. The AI SDK has
 * `tool-approval-request` natively but no symmetric response variant, so
 * this is a codec-local TEvent. On the wire the response is published as
 * a free-standing `role: 'user'` Ably message with its own `x-ably-msg-id`
 * — there is no `targetMsgId` because the reducer redirects the fold by
 * matching `toolCallId` against the assistant's `dynamic-tool` part.
 */
export interface ToolApprovalResponseEvent {
  /** Discriminator. */
  type: 'tool-approval-response';
  /** Tool call this approval responds to. Matches the original tool-input's `toolCallId`. */
  toolCallId: string;
  /** Whether the user approved the tool execution. */
  approved: boolean;
  /** Optional human-readable reason (typically used on denial). */
  reason?: string;
}

/**
 * Wire-only event that starts a regenerate run. Published by the client
 * via `View.regenerate(messageId)` to signal the agent: open a new run
 * forked off the named assistant (`forkOfMsgId`) and thread the new
 * assistant under the existing parent user (`parentMsgId`). Carries no
 * UIMessage content — the agent feeds the LLM from the invocation
 * `history`. Classified as `kind: 'regenerate'` by `classifyEvent` so the
 * client-session publishes it without creating a tree node or folding
 * the projection.
 */
export interface RegenerateEvent {
  /** Discriminator. */
  type: 'ait-regenerate';
  /** The assistant being regenerated — becomes `x-ably-fork-of`. */
  forkOfMsgId: string;
  /** Parent user msg-id for the new assistant chain — becomes `x-ably-parent`. */
  parentMsgId: string;
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

/**
 * Every type of record that flows on the channel for the Vercel codec.
 * Encoded by `Encoder.publish`, decoded by `Decoder.decode`, folded by
 * `UIMessageCodec.fold` into a `VercelProjection`.
 */
export type VercelEvent = AI.UIMessageChunk | UserMessageEvent | ToolApprovalResponseEvent | RegenerateEvent;

// ---------------------------------------------------------------------------
// Projection re-export
// ---------------------------------------------------------------------------

export type { VercelProjection } from './reducer.js';
