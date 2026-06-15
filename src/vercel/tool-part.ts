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
