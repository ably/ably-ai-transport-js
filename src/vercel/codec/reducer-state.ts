/**
 * Shared reducer state: the projection shape, its internal tracker types,
 * `init`, and the message/tracker lookup helpers the per-concern fold modules
 * build on. This module is the base of the reducer's import DAG — the fold
 * modules depend on it; it depends on none of them.
 */

import type * as AI from 'ai';

import type { CodecMessage } from '../../core/codec/index.js';
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
// Projection
// ---------------------------------------------------------------------------

/**
 * The per-Run state produced by the Vercel codec's reducer.
 *
 * The SDK reads only `messages` (via `Codec.getMessages`). The remaining
 * fields are internal to the reducer; they happen to live on the
 * projection because the projection is the only thing the reducer can
 * carry from fold to fold (it has no instance state).
 */
export interface VercelProjection {
  /**
   * UIMessages produced or modified in this Run, in publication order,
   * each paired with its codec-message-id. The reducer correlates strictly
   * on `codecMessageId`; `message.id` is preserved verbatim from the source
   * (the AI SDK stream's `start.messageId` for assistants, the caller's id
   * for user messages) and is never used as an identity key.
   */
  messages: CodecMessage<AI.UIMessage>[];
  /** Per-codecMessageId tracker state for streamed parts. Internal — do not access. */
  trackers: Map<string, MessageTrackers>;
  /**
   * Tool-resolution events that arrived before any assistant in this
   * projection had a matching `toolCallId`. Re-evaluated on every
   * subsequent fold so that an out-of-order tool output is folded as
   * soon as the corresponding assistant lands.
   */
  pendingToolResolutions: PendingToolResolution[];
}

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
// init
// ---------------------------------------------------------------------------

/**
 * Build an empty initial projection.
 * @returns A fresh VercelProjection with no messages and no tracker state.
 */
export const init = (): VercelProjection => ({
  messages: [],
  trackers: new Map(),
  pendingToolResolutions: [],
});

// ---------------------------------------------------------------------------
// Message + tracker helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the assistant message for a codec-message-id, creating an empty
 * placeholder when none exists yet.
 * @param state - Projection to read or extend.
 * @param codecMessageId - The codec-message-id to resolve.
 * @returns The existing or newly-seeded UIMessage for that id.
 */
export const ensureMessage = (state: VercelProjection, codecMessageId: string): AI.UIMessage => {
  let entry = state.messages.find((e) => e.codecMessageId === codecMessageId);
  if (!entry) {
    // No source id seen yet — seed the domain `message.id` with the
    // codec-message-id as a fallback. The `start` chunk overwrites it with
    // the stream's `messageId` when the stream provides one.
    entry = { codecMessageId, message: { id: codecMessageId, role: 'assistant', parts: [] } };
    state.messages.push(entry);
  }
  return entry.message;
};

/**
 * Resolve the stream trackers for a codec-message-id, creating empty maps
 * when none exist yet.
 * @param state - Projection to read or extend.
 * @param messageId - The codec-message-id whose trackers to resolve.
 * @returns The existing or newly-created tracker maps for that id.
 */
export const ensureTrackers = (state: VercelProjection, messageId: string): MessageTrackers => {
  let trackers = state.trackers.get(messageId);
  if (!trackers) {
    trackers = { text: new Map(), reasoning: new Map(), tools: new Map() };
    state.trackers.set(messageId, trackers);
  }
  return trackers;
};

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
