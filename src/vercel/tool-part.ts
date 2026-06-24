/**
 * Shared tool-part type guard for the Vercel layer.
 *
 * The codec normalises every tool part to the `dynamic-tool` shape, but the AI
 * SDK emits `tool-${name}` parts for statically-declared tools. Both shapes
 * carry `toolCallId` and `state`. The guard accepts either representation so
 * the transport's unresolved-tool detection and the React overlay merge can
 * match tool parts uniformly — and so the cross-representation rule lives in
 * one place rather than being re-spelled per call site.
 */

import type * as AI from 'ai';

/** A UIMessage tool part in either the `dynamic-tool` or `tool-${name}` representation. */
export type ToolPart = AI.DynamicToolUIPart | AI.ToolUIPart;

/**
 * Whether a UIMessage part is a tool part of either representation. The
 * `toolCallId`/`state` shape check is defensive against a future AI SDK release
 * introducing a non-tool variant under the `tool-` prefix (none exists today).
 * @param part - The UIMessage part to inspect.
 * @returns True when the part is a tool part.
 */
export const isToolPart = (part: AI.UIMessage['parts'][number]): part is ToolPart =>
  (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) && 'toolCallId' in part && 'state' in part;

/**
 * Tool-part states in which the model has emitted a tool call but no result or
 * approval decision has been folded yet — the call is "unresolved". A message
 * holding such a part flattens into an LLM prompt as a dangling `tool_use` with
 * no matching `tool_result`, which the provider rejects.
 *
 * `input-streaming` is included deliberately: rather than rely on
 * `convertToModelMessages` dropping a still-streaming tool part, we treat it as
 * unresolved at source. The resolved states (`output-available`,
 * `output-error`, `output-denied`, `approval-responded`) are absent.
 *
 * Single source of truth shared by every "is this an unresolved tool call"
 * check — the codec's `isPromptSafe` (prompt construction) and the client-side
 * fork-on-unresolved-tool gate (`hasUnresolvedToolCall`) — so the two can't drift.
 */
export const UNRESOLVED_TOOL_STATES = new Set<string>(['input-streaming', 'input-available', 'approval-requested']);

/**
 * Whether `part` is a tool part still awaiting resolution — the {@link isToolPart}
 * guard combined with membership of {@link UNRESOLVED_TOOL_STATES}.
 * @param part - The UIMessage part to inspect.
 * @returns True when the part is an unresolved tool call.
 */
export const isUnresolvedToolPart = (part: AI.UIMessage['parts'][number]): boolean =>
  isToolPart(part) && UNRESOLVED_TOOL_STATES.has(part.state);
