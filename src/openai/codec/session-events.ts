/**
 * The session layer's OpenAI input union and payloads.
 *
 * The sessions and the Tree consume the well-known five-variant input
 * taxonomy (`user-message`, `regenerate`, the tool variants), which the
 * public wire codec no longer models. These types, and the session codec
 * assembled from them (`session-codec.ts`), exist for the session layer
 * alone. The public wire union lives in `events.ts`.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type {
  Regenerate,
  ToolApprovalResponse,
  ToolResult,
  ToolResultError,
  UserMessage,
} from '../../core/transport/session-codec.js';
import type { OpenAIMessage } from './events.js';

/**
 * Domain payload for a client-published {@link ToolResult}. Folds into a
 * `function_call_output` input item, which is already a `ResponseInputItem`, so
 * the result round-trips to `/responses` unchanged. Uses OpenAI snake_case
 * `call_id` to match the Responses item it becomes.
 */
export interface OpenAIToolResultPayload {
  /** The `call_id` of the `function_call` this result answers. */
  call_id: string;
  /** The tool's output — text or a content list, exactly the `function_call_output.output` shape. */
  output: Responses.ResponseInputItem.FunctionCallOutput['output'];
}

/**
 * Domain payload for a client-published {@link ToolResultError}. OpenAI's
 * `function_call_output` has no error field, so the failure message folds into
 * the item's `output`; the reducer records `failed` in the per-`call_id`
 * tool-call state so clients can render it as failed. Uses snake_case `call_id`.
 */
export interface OpenAIToolResultErrorPayload {
  /** The `call_id` of the `function_call` that failed. */
  call_id: string;
  /** Human-readable description of the failure, folded into the `function_call_output.output`. */
  message: string;
}

/**
 * Domain payload for a client-published {@link ToolApprovalResponse}, the answer
 * to a {@link ToolApprovalRequestEvent}. A denial folds a rejection
 * `function_call_output` so the `/responses` round-trip has no dangling
 * `function_call`; both decisions are recorded in the per-`call_id` tool-call
 * state. Uses snake_case `call_id`.
 */
export interface OpenAIToolApprovalResponsePayload {
  /** The `call_id` of the gated `function_call`. */
  call_id: string;
  /** Whether the user approved the tool execution. */
  approved: boolean;
  /** Optional human-readable reason, typically supplied on denial. */
  reason?: string;
}

/**
 * The session codec's `TInput` — what a session client publishes on the
 * `ai-input` wire: the well-known
 * user-message variant, the {@link Regenerate} signal (a wire-only reference to
 * the assistant message being regenerated, which carries no projection state),
 * and the three client-driven tool variants, parameterized by the OpenAI domain
 * payloads. A {@link ToolResult} / {@link ToolResultError} carries a client-run
 * tool's output or failure; a {@link ToolApprovalResponse} answers a codec
 * {@link ToolApprovalRequestEvent}. Including these variants flips the matching
 * `create*` factories on at the type level (see the codec's `factories` selector).
 */
export type OpenAISessionInput =
  | UserMessage<OpenAIMessage>
  | Regenerate
  | ToolResult<OpenAIToolResultPayload>
  | ToolResultError<OpenAIToolResultErrorPayload>
  | ToolApprovalResponse<OpenAIToolApprovalResponsePayload>;
