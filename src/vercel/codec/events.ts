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
} from '../../core/codec/types.js';

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

/**
 * The Vercel codec's `TInput` — every record-shape a client publishes on
 * the `ai-input` wire. Composed entirely from the SDK's well-known input
 * shapes; the codec layers no Vercel-specific input variants.
 */
export type VercelInput = UserMessage<AI.UIMessage> | Regenerate | ToolResult | ToolResultError | ToolApprovalResponse;

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
