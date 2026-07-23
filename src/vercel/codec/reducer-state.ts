/**
 * Shared reducer state: the projection shape, its internal tracker types, and
 * the tool-part lookup helper the per-concern fold modules build on. The
 * projection, its entry store, and `init` are owned by the shared spine
 * ({@link defineReducer}); this module names the Vercel-specific tracker and
 * extra state-object types that parameterise it. This module is the base of the
 * reducer's import DAG — the fold modules depend on it; it depends on none of
 * them.
 */

import type * as AI from 'ai';

import type { ReducerCtx, ReducerProjection } from '../../core/codec/index.js';
import { isToolPart, type ToolPart } from '../tool-part.js';

// ---------------------------------------------------------------------------
// Internal tracker state
// ---------------------------------------------------------------------------

/**
 * Tracks an in-progress tool part within a UIMessage. Text and reasoning
 * parts don't need this — we write to them directly via partIndex. Tool
 * parts need an extra `inputText` buffer because deltas arrive as raw
 * JSON fragments that must be accumulated before parsing.
 */
export interface ToolPartTracker {
  /** Index in the message's parts array. */
  partIndex: number;
  /** Accumulated streaming input text (for JSON parsing on completion). */
  inputText: string;
}

/** Per-codecMessageId tracking state for in-progress streams within a UIMessage. */
export interface MessageTrackers {
  /** Text stream id → partIndex. */
  text: Map<string, number>;
  /** Reasoning stream id → partIndex. */
  reasoning: Map<string, number>;
  /** Tool call id → tracker. */
  tools: Map<string, ToolPartTracker>;
}

// ---------------------------------------------------------------------------
// Extra state object
// ---------------------------------------------------------------------------

/**
 * The Vercel reducer's projection-level state object: the buffer of tool
 * resolutions that arrived before the assistant they target. Seeded by the
 * reducer's `initExtra`; drained by `retryPendingResolutions` after every fold.
 */
export interface VercelExtra {
  /**
   * Tool-resolution events that arrived before any assistant in this
   * projection had a matching `toolCallId`. Re-evaluated on every subsequent
   * fold so an out-of-order tool output is folded as soon as the corresponding
   * assistant lands.
   */
  pending: PendingToolResolution[];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * The per-Run state produced by the Vercel codec's reducer: the shared spine's
 * {@link ReducerProjection} specialised to the Vercel message, tracker, and
 * extra state-object types. The SDK reads only the reconstructed `messages` (via
 * `Codec.getMessages`); `trackers` and `extra` are internal reducer state.
 *
 * The generic params thread through the projected `AI.UIMessage`, each
 * defaulting to the SDK default, so an unparameterized `VercelProjection` — as
 * the reducer internals use it — resolves to the all-defaults instantiation.
 * @template TMetadata - Per-message metadata type on the projected messages.
 * @template TDataParts - Custom data-part types on the projected messages.
 * @template TTools - Tool set typing the projected messages' tool parts.
 */
export type VercelProjection<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> = ReducerProjection<AI.UIMessage<TMetadata, TDataParts, TTools>, MessageTrackers, VercelExtra>;

/**
 * The fold-body capability object the Vercel fold modules receive: the shared
 * spine's {@link ReducerCtx} specialised to the Vercel message, tracker, and
 * extra state-object types, with roles drawn from `AI.UIMessage`.
 */
export type VercelCtx = ReducerCtx<AI.UIMessage, MessageTrackers, VercelExtra, AI.UIMessage['role']>;

/**
 * A buffered tool resolution waiting for its assistant message to arrive.
 * The reducer scans pending entries after every successful fold so an
 * out-of-order tool output is promoted as soon as the matching assistant
 * is added to the projection.
 */
export interface PendingToolResolution {
  /** The codec-message-id of the assistant the resolution targets. */
  targetCodecMessageId: string;
  /** Tool call this resolution targets. */
  toolCallId: string;
  /** Variant of the tool-resolution used to transition the assistant's tool part. */
  resolution:
    | { kind: 'tool-result'; output: unknown }
    | { kind: 'tool-result-error'; message: string }
    | { kind: 'tool-approval-response'; approved: boolean; reason?: string };
}

/** A located tool part (either representation) with its owning message and tracker. */
export interface OwnerLookup {
  /** The message owning the tool part. */
  message: AI.UIMessage;
  /** The tracker pointing at the part's index. */
  tracker: ToolPartTracker;
  /** The resolved tool part itself, in whichever representation it was reconstructed. */
  part: ToolPart;
}

// ---------------------------------------------------------------------------
// Tool-part helper
// ---------------------------------------------------------------------------

/**
 * Resolve the tool part tracked for a toolCallId within a message, in whichever
 * representation it was reconstructed (`dynamic-tool` or `tool-${name}`).
 * @param message - The message whose parts to read.
 * @param trackers - The message's tracker maps.
 * @param toolCallId - The tool call to resolve.
 * @returns The tracker and part, or `undefined` if untracked or the tracked part is not a tool part.
 */
export const getToolPart = (
  message: AI.UIMessage,
  trackers: MessageTrackers,
  toolCallId: string,
): { tracker: ToolPartTracker; part: ToolPart } | undefined => {
  const tracker = trackers.tools.get(toolCallId);
  if (!tracker) return undefined;
  const part = message.parts[tracker.partIndex];
  if (!part || !isToolPart(part)) return undefined;
  return { tracker, part };
};
