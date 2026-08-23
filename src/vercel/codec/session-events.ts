/**
 * The session layer's Vercel input union and payloads.
 *
 * The sessions and the Tree consume the well-known five-variant input
 * taxonomy (`user-message`, `regenerate`, the tool variants), which the
 * public wire codec no longer models. These types, and the session codec
 * assembled from them (`session-codec.ts`), exist for the session layer
 * alone. The public wire union lives in `events.ts`.
 */

import type * as AI from 'ai';

import type {
  CodecMessage,
  Regenerate,
  ToolApprovalResponse,
  ToolResult,
  ToolResultError,
  UserMessage,
} from '../../core/transport/session-codec.js';

// ---------------------------------------------------------------------------
// Domain payloads
//
// The core well-known tool variants are domain-independent: the Vercel
// layer supplies the concrete payload shapes. Tool outputs are inherently
// tool-defined, so `output` stays `unknown` — but confined here, never in
// the core.
// ---------------------------------------------------------------------------

/**
 * A self-contained copy of the SUSPENDED RUN's full message list, so a fork
 * continuation reconstructs that run's entire projection in its OWN run without
 * depending on the suspended run it forked from.
 *
 * Carried on a tool-result / tool-result-error input when the client opens a
 * fork continuation (a concurrent answer to a shared tool call). Each seed
 * message pairs a FRESH client-minted `codecMessageId` with the message content
 * (its domain `id` + parts) in its current state — prior resolved tool calls as
 * well as the one being answered now. The reducer uses it only when the target
 * assistant is absent from the fork's projection: it reconstructs every seed
 * message (registering tool-part trackers), then applies this fork's result
 * onto the target — reconstructing the same run the trunk holds, carrying THIS
 * fork's result and the FULL prior context. Carrying the whole run (not just the
 * current tool-call assistant) keeps context across SEQUENTIAL client tool
 * calls. See `fold-input.ts`.
 */
export interface ForkSeed {
  /**
   * The suspended run's message list, each under a FRESH client-minted
   * `codecMessageId`, in publication order. Carries the messages in their
   * current state (earlier tool calls already resolved; the current one still
   * awaiting this result, applied separately from the input's own payload).
   */
  messages: CodecMessage<AI.UIMessage>[];
}

/** Vercel domain payload for a {@link ToolResult}. */
export interface VercelToolResultPayload {
  /** The tool call this result corresponds to. */
  toolCallId: string;
  /** The tool's output value. Tool-defined shape. */
  output: unknown;
  /**
   * Fork-continuation reconstruction seed (see {@link ForkSeed}). Present only
   * when this result opens a fork run for a concurrently-answered tool call;
   * omitted for a result folding onto an assistant already in the projection.
   */
  forkSeed?: ForkSeed;
}

/** Vercel domain payload for a {@link ToolResultError}. */
export interface VercelToolResultErrorPayload {
  /** The tool call this error corresponds to. */
  toolCallId: string;
  /** Human-readable description of the failure. */
  message: string;
  /**
   * Fork-continuation reconstruction seed (see {@link ForkSeed}); present under
   * the same condition as on {@link VercelToolResultPayload}.
   */
  forkSeed?: ForkSeed;
}

/** Vercel domain payload for a {@link ToolApprovalResponse}. */
export interface VercelToolApprovalResponsePayload {
  /** The tool call this approval responds to. */
  toolCallId: string;
  /** Whether the user approved the tool execution. */
  approved: boolean;
  /** Optional human-readable reason (typically used on denial). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

/**
 * The session codec's `TInput` — every record-shape a session client
 * publishes on the `ai-input` wire. Composed from the SDK's well-known input
 * shapes, with the tool variants parameterized by the Vercel domain payloads
 * above.
 *
 * The generic params thread through the `UserMessage` arm's `AI.UIMessage`;
 * the tool-resolution arms carry Vercel domain payloads that do not depend on
 * them (a tool result's `output` is `unknown` regardless — tool typing lands on
 * the assistant's message parts via `getMessages`). Each defaults to the SDK
 * default, so an unparameterized `VercelInput` resolves to the all-defaults instantiation.
 * @template TMetadata - Per-message metadata type carried by a user message.
 * @template TDataParts - Custom data-part types on a user message.
 * @template TTools - Tool set typing the user message's tool parts.
 */
export type VercelSessionInput<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> =
  | UserMessage<AI.UIMessage<TMetadata, TDataParts, TTools>>
  | Regenerate
  | ToolResult<VercelToolResultPayload>
  | ToolResultError<VercelToolResultErrorPayload>
  | ToolApprovalResponse<VercelToolApprovalResponsePayload>;
