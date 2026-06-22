/**
 * Shared reducer state: the projection shape, its internal tracker types,
 * `init`, and the message/tracker lookup helpers the per-concern fold modules
 * build on. This module is the base of the reducer's import DAG — the fold
 * modules depend on it; it depends on none of them.
 */

import type * as AI from 'ai';

import type { CodecMessage } from '../../core/codec/index.js';

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
 * The SDK reads only the materialised message list (via `Codec.getMessages`).
 * The remaining fields are internal to the reducer; they happen to live on the
 * projection because the projection is the only thing the reducer can carry
 * from fold to fold (it has no instance state).
 *
 * The type is RECURSIVE: a node holds its own messages plus a map of
 * {@link Continuation}s — concurrent branches that resolve this node's tail
 * tool call (e.g. two browser tabs each executing the same client-side tool
 * call under one suspended run). Each continuation is itself a
 * `VercelProjection`, so multi-step client-tool sequences nest naturally. A
 * run with no client-side tool branching has an empty `continuations` map and
 * behaves exactly like a flat projection.
 */
export interface VercelProjection {
  /**
   * UIMessages produced or modified at THIS node, in publication order, each
   * paired with its codec-message-id. For the root this is the conversation up
   * to and including the assistant that issued the tool call; for a
   * continuation it is that assistant's resolved copy followed by the
   * follow-up(s) the responder generated. The reducer correlates strictly on
   * `codecMessageId`; `message.id` is preserved verbatim from the source (the
   * AI SDK stream's `start.messageId` for assistants, the caller's id for user
   * messages) and is never used as an identity key.
   */
  messages: CodecMessage<AI.UIMessage>[];
  /** Per-codecMessageId tracker state for streamed parts at this node. Internal — do not access. */
  trackers: Map<string, MessageTrackers>;
  /**
   * Tool-resolution events that arrived before any assistant in this
   * node had a matching `toolCallId`. Re-evaluated on every
   * subsequent fold so that an out-of-order tool output is folded as
   * soon as the corresponding assistant lands.
   */
  pendingToolResolutions: PendingToolResolution[];
  /**
   * Concurrent continuations of this node's tail tool call, keyed by the
   * triggering input's `event-id` (the `input-event-id` the agent echoes).
   * Each holds the resolved copy of the assistant plus its follow-up — its own
   * sub-projection — so two responders' results never compete for one part.
   * Empty for a node with no client-side tool branching.
   */
  continuations: Map<string, Continuation>;
}

/**
 * One concurrent branch resolving a node's tail tool call: a responder's
 * tool-result + the follow-up it triggered, held as a nested
 * {@link VercelProjection}.
 */
export interface Continuation {
  /**
   * Lowest canonical (CGO) serial seen for this continuation's seeding
   * tool-result, or `''` while only an optimistic local seed exists. Orders
   * continuations deterministically for the canonical pick — the same order a
   * live subscriber and a history-hydrating client converge on.
   */
  seedSerial: string;
  /** The continuation's sub-projection (resolved assistant copy + follow-up + any nested continuations). */
  projection: VercelProjection;
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

/** A located `dynamic-tool` part with its owning message and tracker. */
export interface OwnerLookup {
  /** The message owning the tool part. */
  message: AI.UIMessage;
  /** The tracker pointing at the part's index. */
  tracker: ToolPartTracker;
  /** The resolved `dynamic-tool` part itself. */
  part: AI.DynamicToolUIPart;
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
  continuations: new Map(),
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
 * Resolve the `dynamic-tool` part tracked for a toolCallId within a message.
 * @param message - The message whose parts to read.
 * @param trackers - The message's tracker maps.
 * @param toolCallId - The tool call to resolve.
 * @returns The tracker and part, or `undefined` if untracked or the part is not a dynamic-tool.
 */
export const getToolPart = (
  message: AI.UIMessage,
  trackers: MessageTrackers,
  toolCallId: string,
): { tracker: ToolPartTracker; part: AI.DynamicToolUIPart } | undefined => {
  const tracker = trackers.tools.get(toolCallId);
  if (!tracker) return undefined;
  const part = message.parts[tracker.partIndex];
  if (part?.type !== 'dynamic-tool') return undefined;
  return { tracker, part };
};
