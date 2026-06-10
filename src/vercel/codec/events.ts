/**
 * Vercel codec input/output unions.
 *
 * The codec splits cleanly along the protocol's `ai-input` / `ai-output`
 * wire seam:
 *
 * - **`VercelOutput`** = `AI.UIMessageChunk` — the AI SDK's streamed-output
 *   domain model, published by the agent on `ai-output`.
 * - **`VercelInput`** = a discriminated union of the SDK's well-known
 *   input shapes — published by the client on `ai-input`. The Vercel
 *   codec has no codec-local input variants today: every variant comes
 *   from `@ably/ai-transport`'s well-known set.
 */

import type * as AI from 'ai';

import type {
  Regenerate,
  ToolApprovalResponse,
  ToolResult,
  ToolResultError,
  UserMessage,
} from '../../core/codec/index.js';

// ---------------------------------------------------------------------------
// Domain payloads
//
// The core well-known tool variants are domain-independent: the Vercel
// layer supplies the concrete payload shapes. Tool outputs are inherently
// tool-defined, so `output` stays `unknown` — but confined here, never in
// the core.
// ---------------------------------------------------------------------------

/** Vercel domain payload for a {@link ToolResult}. */
export interface VercelToolResultPayload {
  /** The tool call this result corresponds to. */
  toolCallId: string;
  /** The tool's output value. Tool-defined shape. */
  output: unknown;
}

/** Vercel domain payload for a {@link ToolResultError}. */
export interface VercelToolResultErrorPayload {
  /** The tool call this error corresponds to. */
  toolCallId: string;
  /** Human-readable description of the failure. */
  message: string;
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
 * The Vercel codec's `TInput` — every record-shape a client publishes on
 * the `ai-input` wire. Composed from the SDK's well-known input shapes,
 * with the tool variants parameterized by the Vercel domain payloads above.
 */
export type VercelInput =
  | UserMessage<AI.UIMessage>
  | Regenerate
  | ToolResult<VercelToolResultPayload>
  | ToolResultError<VercelToolResultErrorPayload>
  | ToolApprovalResponse<VercelToolApprovalResponsePayload>;

/**
 * The Vercel codec's `TOutput` — every record-shape the agent publishes
 * on the `ai-output` wire. The Vercel codec passes the AI SDK's
 * `UIMessageChunk` through unchanged.
 */
export type VercelOutput = AI.UIMessageChunk;

// ---------------------------------------------------------------------------
// Projection re-export
// ---------------------------------------------------------------------------

export type { VercelProjection } from './reducer.js';
