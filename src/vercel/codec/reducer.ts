/**
 * Vercel AI SDK reducer.
 *
 * Pure `(init, fold)` over the Vercel TEvent union. Folds chunks and
 * codec-local events (user-message, tool-approval-response) into a
 * VercelProjection holding `UIMessage[]` plus internal stream-tracker state.
 *
 * The reducer is stateless: every fold is `(state, event, meta) → state'`,
 * with no instance state. Mutation in place is allowed — the projection is
 * single-owner.
 *
 * Idempotency is **per conflict key**, not stream-wide: when two events
 * compete for the same logical state (e.g. two `tool-output-available` for
 * the same `toolCallId`), the higher-serial one wins and the other is
 * dropped. Unrelated events arrive freely in any order. See
 * `_conflictKeyOf` for the per-variant key derivation.
 *
 * Client-published continuation tool-resolution events (tool outputs /
 * approval responses published as `role: 'user'` channel messages) are
 * redirected by `toolCallId` onto the prior assistant in the same
 * projection — the wire `messageId` (the continuation's own new codec-message-id)
 * is added to a `consumedCodecMessageIds` set so the user-message never appears
 * in `getMessages()` output. Continuation flow runs the standard fold
 * paths but with a per-event toolCallId lookup; no separate code path.
 *
 * The projection is session-wide: the Tree folds every Run's
 * events into one VercelProjection. The toolCallId scan therefore spans
 * every Run, so a continuation tool-output naturally finds its suspended
 * assistant wherever it lives — no per-Run routing needed. toolCallIds are
 * unique per LLM call, so the cross-Run scan stays unambiguous.
 */

import type * as AI from 'ai';

import type { ReducerMeta } from '../../core/codec/types.js';
import { stripUndefined } from '../../utils.js';
import type { ToolApprovalResponseEvent, UserMessageEvent, VercelEvent } from './events.js';
import { toolBase, transitionToolPart } from './tool-transitions.js';

// ---------------------------------------------------------------------------
// Internal tracker state
// ---------------------------------------------------------------------------

/**
 * Tracks an in-progress tool part within a UIMessage. Text and reasoning
 * parts don't need this — we write to them directly via partIndex. Tool
 * parts need an extra `inputText` buffer because deltas arrive as raw
 * JSON fragments that must be accumulated before parsing.
 */
interface ToolPartTracker {
  /** Index in the message's parts array. */
  partIndex: number;
  /** Accumulated streaming input text (for JSON parsing on completion). */
  inputText: string;
}

/** Per-codecMessageId tracking state for in-progress streams within a UIMessage. */
interface MessageTrackers {
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
  /** UIMessages produced or modified in this Run, in publication order. */
  messages: AI.UIMessage[];
  /**
   * Per-conflict-key high-water-marks. Maps a codec-derived conflict key
   * (see `_conflictKeyOf`) to the highest `meta.serial` already folded for
   * that key. Events whose serial is `<=` the stored value are dropped as
   * duplicates of an already-incorporated operation. Events that have no
   * conflict key (additive content, lifecycle markers) are folded
   * unconditionally.
   */
  conflictSerials: Map<string, string>;
  /** Per-codecMessageId tracker state for streamed parts. Internal — do not access. */
  trackers: Map<string, MessageTrackers>;
  /**
   * Wire `x-ably-codec-message-id`s that have been consumed by tool-resolution
   * redirection — the message carried only tool outputs / approvals which
   * were folded onto a prior assistant by `toolCallId`. `getMessages()`
   * filters these out so the consumed wire message never materialises as
   * its own UIMessage / Tree node.
   */
  consumedCodecMessageIds: Set<string>;
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
interface PendingToolResolution {
  /** Wire `x-ably-codec-message-id` to mark consumed once the resolution promotes. */
  consumedCodecMessageId: string;
  /** Tool call this resolution targets. */
  toolCallId: string;
  /** Serial of the wire message — used by the conflict-key check on promotion. */
  serial: string;
  /** Variant of the tool-resolution chunk used to transition the assistant's tool part. */
  resolution:
    | { kind: 'tool-output-available'; output: unknown }
    | { kind: 'tool-output-error'; errorText: string }
    | { kind: 'tool-approval-response'; approved: boolean; reason?: string };
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
  conflictSerials: new Map(),
  trackers: new Map(),
  consumedCodecMessageIds: new Set(),
  pendingToolResolutions: [],
});

// ---------------------------------------------------------------------------
// fold
// ---------------------------------------------------------------------------

/**
 * Fold one VercelEvent into the projection. Mutates and returns `state`.
 *
 * Idempotency is per conflict key (see `_conflictKeyOf`): if the event has
 * a conflict key and the projection has already folded an event for that
 * key at a higher-or-equal serial, this call is a no-op. Events without a
 * conflict key (additive content, lifecycle markers) are folded
 * unconditionally. Orphan events (e.g. tool-output for an unknown
 * toolCallId) are dropped silently inside the per-variant fold helpers.
 * @param state - Projection to fold into (may be mutated in place).
 * @param event - VercelEvent to fold.
 * @param meta - Transport-derived metadata (serial, optional messageId).
 * @returns The same projection reference, possibly mutated.
 */
export const fold = (state: VercelProjection, event: VercelEvent, meta: ReducerMeta): VercelProjection => {
  if (meta.serial) {
    const key = _conflictKeyOf(event, meta);
    if (key !== undefined) {
      const seen = state.conflictSerials.get(key);
      if (seen !== undefined && meta.serial <= seen) {
        return state;
      }
      state.conflictSerials.set(key, meta.serial);
    }
  }

  switch (event.type) {
    case 'ait-user-message': {
      _foldUserMessage(state, event, meta);
      break;
    }
    case 'tool-approval-response': {
      _foldToolApprovalResponse(state, event, meta);
      break;
    }
    case 'tool-output-available':
    case 'tool-output-error': {
      _foldToolOutputChunk(state, event, meta);
      break;
    }
    case 'ait-regenerate': {
      // Regenerate event — wire-only. Carries no projection state; the
      // agent reads `parent`/`forkOf` directly from transport headers
      // via the prompt-lookup path. No fold work to do here.
      break;
    }
    default: {
      _foldChunk(state, event, meta);
      break;
    }
  }

  // Re-evaluate pending tool resolutions in case the just-folded event
  // produced the assistant they were waiting on. Cheap when the list is
  // empty (the common case).
  if (state.pendingToolResolutions.length > 0) {
    _retryPendingResolutions(state);
  }

  return state;
};

// ---------------------------------------------------------------------------
// Conflict-key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a per-event conflict key, or `undefined` if the event doesn't
 * compete with any other event for shared state. Used by `fold` to scope
 * the high-water-mark check to genuine conflicts (e.g. two
 * `tool-output-available` for the same `toolCallId`) rather than to every
 * event in the stream.
 * @param event - The event being folded.
 * @param meta - Transport-derived metadata (used for events keyed by codec-message-id).
 * @returns The conflict key, or `undefined` if the event is additive / independent.
 */
const _conflictKeyOf = (event: VercelEvent, meta: ReducerMeta): string | undefined => {
  switch (event.type) {
    case 'ait-user-message': {
      // Key on the wire codec-message-id (meta.messageId), matching how
      // _foldUserMessage stores the message (its id is aligned to
      // meta.messageId). This keeps the key in dropMessages' codec-message-id
      // namespace, so a winner-flip or delete eviction prunes it and a later
      // re-fold is not wrongly suppressed by a stale high-water-mark. Falls
      // back to the message's own id when no wire id is supplied.
      return `user-msg:${meta.messageId ?? event.message.id}`;
    }
    case 'tool-approval-response': {
      return `tool-approval:${event.toolCallId}`;
    }

    // Tool-input state machine, keyed by toolCallId.
    case 'tool-input-start':
    case 'tool-input-available':
    case 'tool-input-error': {
      return `${event.type}:${event.toolCallId}`;
    }

    // All "tool-output-ish" variants compete for the same final state of
    // the tool call. Highest-serial wins among them.
    case 'tool-output-available':
    case 'tool-output-error':
    case 'tool-output-denied':
    case 'tool-approval-request': {
      return `tool-output:${event.toolCallId}`;
    }

    // Per-stream start/end markers: duplicates would create phantom parts
    // or wipe accumulated text. Keyed by (codec-message-id, stream-id).
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end': {
      return `${event.type}:${meta.messageId ?? ''}:${event.id}`;
    }

    // Message-level markers, keyed by codec-message-id.
    case 'finish':
    case 'message-metadata': {
      return `${event.type}:${meta.messageId ?? ''}`;
    }

    // Purely additive or independent — never dedup:
    //   text-delta / reasoning-delta / tool-input-delta (additive content)
    //   start / start-step / finish-step / abort / error (lifecycle)
    //   file / source-url / source-document (independent attachments)
    //   data-* (opaque to the reducer)
    default: {
      return undefined;
    }
  }
};

// ---------------------------------------------------------------------------
// Codec-local event folds
// ---------------------------------------------------------------------------

const _foldUserMessage = (state: VercelProjection, event: UserMessageEvent, meta: ReducerMeta): VercelProjection => {
  // Align the projection's UIMessage.id with the wire `x-ably-msg-id`
  // (= meta.messageId) so the Tree's _codecMessageIdToRunId index is reachable from
  // any consumer holding the UIMessage. Without this, useChat-supplied
  // domain ids leak through, and downstream lookups (view.regenerate /
  // view.edit / view.getRunByCodecMessageId) silently miss because the tree only
  // indexes wire msg-ids.
  const targetId = meta.messageId ?? event.message.id;
  const aligned = event.message.id === targetId ? event.message : { ...event.message, id: targetId };
  const existingIdx = state.messages.findIndex((m) => m.id === targetId);
  if (existingIdx === -1) {
    state.messages.push(aligned);
  } else {
    state.messages[existingIdx] = aligned;
  }
  return state;
};

/**
 * Fold a client-published `tool-approval-response` event by redirecting
 * the resolution onto the prior assistant in this projection whose
 * `dynamic-tool` part matches the response's `toolCallId`. The wire
 * message-id is recorded in `consumedCodecMessageIds` so the response never
 * surfaces as its own UIMessage. Orphans (no matching assistant) are
 * buffered and re-evaluated on each subsequent fold.
 * @param state - Projection to fold into.
 * @param event - The approval-response event (toolCallId, approved, optional reason).
 * @param meta - Transport-derived metadata; `messageId` is the wire `x-ably-codec-message-id` consumed on success.
 * @returns The same projection reference.
 */
const _foldToolApprovalResponse = (
  state: VercelProjection,
  event: ToolApprovalResponseEvent,
  meta: ReducerMeta,
): VercelProjection => {
  const messageId = meta.messageId;
  if (messageId !== undefined) {
    const owner = state.messages.find((m) => m.id === messageId);
    if (owner) {
      const trackers = _ensureTrackers(state, messageId);
      const found = _getToolPart(owner, trackers, event.toolCallId);
      if (found) {
        owner.parts[found.tracker.partIndex] = _approvalTransition(found.part, event.approved, event.reason);
        return state;
      }
    }
  }

  const promoted = _promoteApprovalOntoAssistant(state, event.toolCallId, event.approved, event.reason);
  if (promoted) {
    if (messageId) state.consumedCodecMessageIds.add(messageId);
  } else if (messageId) {
    state.pendingToolResolutions.push({
      consumedCodecMessageId: messageId,
      toolCallId: event.toolCallId,
      serial: meta.serial,
      resolution: {
        kind: 'tool-approval-response',
        approved: event.approved,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      },
    });
  }
  return state;
};

/**
 * Fold a `tool-output-available` or `tool-output-error` UIMessageChunk.
 * If `meta.messageId` matches an existing message with the toolCallId
 * present as a `dynamic-tool` part, fold onto that message (standard
 * agent-side path). Otherwise — typically a client-published continuation
 * carrying its own wire `codecMessageId` — scan the projection for the prior
 * assistant whose tool part matches and redirect the fold there,
 * consuming the wire `codecMessageId`. Orphans pend until the assistant arrives.
 * @param state - Projection to fold into.
 * @param chunk - The tool-output UIMessageChunk.
 * @param meta - Transport-derived metadata; `messageId` is the wire `x-ably-codec-message-id`.
 * @returns The same projection reference.
 */
const _foldToolOutputChunk = (
  state: VercelProjection,
  chunk: Extract<AI.UIMessageChunk, { type: 'tool-output-available' | 'tool-output-error' }>,
  meta: ReducerMeta,
): VercelProjection => {
  const messageId = meta.messageId;
  if (messageId !== undefined) {
    const owner = state.messages.find((m) => m.id === messageId);
    if (owner) {
      const trackers = _ensureTrackers(state, messageId);
      if (_getToolPart(owner, trackers, chunk.toolCallId)) {
        return _foldToolOutput(state, chunk, messageId);
      }
    }
  }

  // No direct owner — redirect by toolCallId. Client-published
  // continuation outputs land here: the wire codecMessageId is the continuation's
  // own new id, not the suspended assistant's.
  const promoted = _promoteToolChunkOntoAssistant(state, chunk);
  if (promoted) {
    if (messageId) state.consumedCodecMessageIds.add(messageId);
    return state;
  }

  if (messageId) {
    state.pendingToolResolutions.push({
      consumedCodecMessageId: messageId,
      toolCallId: chunk.toolCallId,
      serial: meta.serial,
      resolution:
        chunk.type === 'tool-output-available'
          ? { kind: 'tool-output-available', output: chunk.output }
          : { kind: 'tool-output-error', errorText: chunk.errorText },
    });
  }
  return state;
};

// ---------------------------------------------------------------------------
// Tool-resolution promotion helpers
// ---------------------------------------------------------------------------

/**
 * Find the assistant in the projection whose `dynamic-tool` part matches
 * `toolCallId` and apply a `tool-output-available` / `tool-output-error`
 * transition. Returns `true` when a match was found and updated, `false`
 * otherwise (caller pends or drops).
 *
 * The projection is session-wide, so this scans every Run's
 * messages — a continuation tool-output published under one runId resolves
 * onto a suspended assistant in another Run without per-Run routing.
 * @param state - Projection to search and mutate.
 * @param chunk - Tool-output chunk carrying the new state.
 * @returns True when an assistant was located and promoted.
 */
const _promoteToolChunkOntoAssistant = (
  state: VercelProjection,
  chunk: Extract<AI.UIMessageChunk, { type: 'tool-output-available' | 'tool-output-error' }>,
): boolean => {
  for (const message of state.messages) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i];
      if (part?.type !== 'dynamic-tool' || part.toolCallId !== chunk.toolCallId) continue;
      message.parts[i] = transitionToolPart(part, chunk);
      return true;
    }
  }
  return false;
};

/**
 * Find the assistant whose `dynamic-tool` part matches `toolCallId` and
 * apply the approval-responded / output-denied transition. Returns
 * `true` when a match was found.
 * @param state - Projection to search and mutate.
 * @param toolCallId - Tool call id to locate.
 * @param approved - Whether the user approved the tool execution.
 * @param reason - Optional human-readable reason.
 * @returns True when an assistant was located and promoted.
 */
const _promoteApprovalOntoAssistant = (
  state: VercelProjection,
  toolCallId: string,
  approved: boolean,
  reason: string | undefined,
): boolean => {
  for (const message of state.messages) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i];
      if (part?.type !== 'dynamic-tool' || part.toolCallId !== toolCallId) continue;
      message.parts[i] = _approvalTransition(part, approved, reason);
      return true;
    }
  }
  return false;
};

/**
 * Build the next `dynamic-tool` part shape for an approval response.
 *
 * For `approved=true`, transition to `approval-responded` so the AI SDK's
 * multi-step loop will auto-run the tool on the next step.
 * `transitionToolPart` has no shape for this transition, so we synthesize
 * the part directly.
 *
 * For `approved=false`, delegate to `transitionToolPart` with a synthetic
 * `tool-output-denied` chunk so denial mirrors the chunk-driven path.
 * @param part - The existing `dynamic-tool` part being transitioned.
 * @param approved - Whether the user approved the tool execution.
 * @param reason - Optional human-readable reason.
 * @returns The replacement `dynamic-tool` part.
 */
const _approvalTransition = (
  part: AI.DynamicToolUIPart,
  approved: boolean,
  reason: string | undefined,
): AI.DynamicToolUIPart => {
  if (approved) {
    return {
      ...toolBase(part),
      state: 'approval-responded',
      input: 'input' in part ? part.input : undefined,
      approval: {
        id: 'approval' in part && part.approval ? part.approval.id : '',
        approved: true,
        ...(reason === undefined ? {} : { reason }),
      },
    };
  }
  return transitionToolPart(part, {
    type: 'tool-output-denied',
    toolCallId: part.toolCallId,
    ...(reason === undefined ? {} : { reason }),
  });
};

/**
 * Re-attempt every pending tool resolution against the current projection.
 * Successfully promoted entries are removed and their wire codecMessageIds added to
 * `consumedCodecMessageIds`. Cheap: bounded by the number of pending entries.
 * @param state - Projection to walk and mutate.
 */
const _retryPendingResolutions = (state: VercelProjection): void => {
  const next: PendingToolResolution[] = [];
  for (const pending of state.pendingToolResolutions) {
    let promoted = false;
    switch (pending.resolution.kind) {
      case 'tool-output-available': {
        promoted = _promoteToolChunkOntoAssistant(state, {
          type: 'tool-output-available',
          toolCallId: pending.toolCallId,
          output: pending.resolution.output,
        });
        break;
      }
      case 'tool-output-error': {
        promoted = _promoteToolChunkOntoAssistant(state, {
          type: 'tool-output-error',
          toolCallId: pending.toolCallId,
          errorText: pending.resolution.errorText,
        });
        break;
      }
      case 'tool-approval-response': {
        promoted = _promoteApprovalOntoAssistant(
          state,
          pending.toolCallId,
          pending.resolution.approved,
          pending.resolution.reason,
        );
        break;
      }
    }
    if (promoted) {
      state.consumedCodecMessageIds.add(pending.consumedCodecMessageId);
    } else {
      next.push(pending);
    }
  }
  state.pendingToolResolutions = next;
};

// ---------------------------------------------------------------------------
// UIMessageChunk fold
// ---------------------------------------------------------------------------

const _foldChunk = (state: VercelProjection, chunk: AI.UIMessageChunk, meta: ReducerMeta): VercelProjection => {
  const messageId = meta.messageId;
  if (messageId === undefined) {
    // Without a target codec-message-id, a chunk has nowhere to land. Drop.
    return state;
  }

  switch (chunk.type) {
    case 'start':
    case 'start-step':
    case 'finish-step':
    case 'finish':
    case 'abort':
    case 'error':
    case 'message-metadata': {
      return _foldLifecycle(state, chunk, messageId);
    }

    case 'text-start':
    case 'text-delta':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-delta':
    case 'reasoning-end': {
      return _foldTextOrReasoning(state, chunk, messageId);
    }

    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-input-available':
    case 'tool-input-error': {
      return _foldToolInput(state, chunk, messageId);
    }

    case 'tool-output-denied':
    case 'tool-approval-request': {
      return _foldToolOutput(state, chunk, messageId);
    }

    // `tool-output-available` / `tool-output-error` are dispatched to
    // `_foldToolOutputChunk` by the outer fold() switch; they reach
    // `_foldChunk` only via an unreachable path. Declared explicitly so
    // TypeScript can narrow the default branch to `data-${string}`.
    case 'tool-output-available':
    case 'tool-output-error': {
      return _foldToolOutput(state, chunk, messageId);
    }

    case 'file':
    case 'source-url':
    case 'source-document': {
      return _foldContentPart(state, chunk, messageId);
    }

    default: {
      if (chunk.type.startsWith('data-')) {
        return _foldDataPart(state, chunk, messageId);
      }
      return state;
    }
  }
};

// ---------------------------------------------------------------------------
// Message + tracker helpers
// ---------------------------------------------------------------------------

const _ensureMessage = (state: VercelProjection, messageId: string): AI.UIMessage => {
  let message = state.messages.find((m) => m.id === messageId);
  if (!message) {
    message = { id: messageId, role: 'assistant', parts: [] };
    state.messages.push(message);
  }
  return message;
};

const _ensureTrackers = (state: VercelProjection, messageId: string): MessageTrackers => {
  let trackers = state.trackers.get(messageId);
  if (!trackers) {
    trackers = { text: new Map(), reasoning: new Map(), tools: new Map() };
    state.trackers.set(messageId, trackers);
  }
  return trackers;
};

const _getToolPart = (
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

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

const _foldLifecycle = (
  state: VercelProjection,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'start' | 'start-step' | 'finish-step' | 'finish' | 'abort' | 'error' | 'message-metadata' }
  >,
  messageId: string,
): VercelProjection => {
  switch (chunk.type) {
    case 'start': {
      // The wire HEADER_CODEC_MESSAGE_ID (carried via `meta.messageId`) is the
      // canonical identity for the message inside the projection — every
      // subsequent chunk for this message keys on it. The Vercel `start`
      // chunk also carries an LLM-provided `messageId`, but rewriting
      // `message.id` to it would orphan all later chunks (which still key
      // on the wire id), producing a second, empty message. Keep the wire
      // id authoritative; the LLM id is exposed via the wire header for
      // anyone who needs it.
      const message = _ensureMessage(state, messageId);
      if (chunk.messageMetadata !== undefined) message.metadata = chunk.messageMetadata;
      return state;
    }
    case 'start-step': {
      const message = _ensureMessage(state, messageId);
      message.parts.push({ type: 'step-start' });
      return state;
    }
    case 'finish-step': {
      // Reset text/reasoning stream trackers so a follow-up step can start
      // new parts with potentially-reused stream ids.
      const trackers = state.trackers.get(messageId);
      if (trackers) {
        trackers.text.clear();
        trackers.reasoning.clear();
      }
      return state;
    }
    case 'finish': {
      const message = state.messages.find((m) => m.id === messageId);
      if (message && chunk.messageMetadata !== undefined) {
        message.metadata = chunk.messageMetadata;
      }
      // Tracker state retained — late events still resolvable; cleanup happens at Run end.
      return state;
    }
    case 'abort':
    case 'error': {
      // No state mutation — observers detect terminal via Codec.isTerminal.
      return state;
    }
    case 'message-metadata': {
      const message = state.messages.find((m) => m.id === messageId);
      if (message && chunk.messageMetadata !== undefined) {
        message.metadata = chunk.messageMetadata;
      }
      return state;
    }
  }
};

// ---------------------------------------------------------------------------
// Text and reasoning streaming
// ---------------------------------------------------------------------------

const _foldTextOrReasoning = (
  state: VercelProjection,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'text-start' | 'text-delta' | 'text-end' | 'reasoning-start' | 'reasoning-delta' | 'reasoning-end' }
  >,
  messageId: string,
): VercelProjection => {
  const message = _ensureMessage(state, messageId);
  const trackers = _ensureTrackers(state, messageId);

  const isText = chunk.type.startsWith('text-');
  const partType = isText ? 'text' : 'reasoning';
  const activeMap = isText ? trackers.text : trackers.reasoning;

  switch (chunk.type) {
    case 'text-start':
    case 'reasoning-start': {
      activeMap.set(chunk.id, message.parts.length);
      message.parts.push({ type: partType, text: '' });
      return state;
    }
    case 'text-delta':
    case 'reasoning-delta': {
      const idx = activeMap.get(chunk.id);
      if (idx === undefined) return state;
      const part = message.parts[idx];
      if (part?.type === partType) {
        part.text += chunk.delta;
      }
      return state;
    }
    case 'text-end':
    case 'reasoning-end': {
      activeMap.delete(chunk.id);
      return state;
    }
  }
};

// ---------------------------------------------------------------------------
// Tool input streaming
// ---------------------------------------------------------------------------

const _foldToolInput = (
  state: VercelProjection,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'tool-input-start' | 'tool-input-delta' | 'tool-input-available' | 'tool-input-error' }
  >,
  messageId: string,
): VercelProjection => {
  const message = _ensureMessage(state, messageId);
  const trackers = _ensureTrackers(state, messageId);

  switch (chunk.type) {
    case 'tool-input-start': {
      const partIndex = message.parts.length;
      message.parts.push({ ...toolBase(chunk), state: 'input-streaming', input: undefined });
      trackers.tools.set(chunk.toolCallId, { partIndex, inputText: '' });
      return state;
    }
    case 'tool-input-delta': {
      const tracker = trackers.tools.get(chunk.toolCallId);
      if (!tracker) return state;
      tracker.inputText += chunk.inputTextDelta;

      let parsedInput: unknown;
      try {
        // CAST: JSON.parse returns any; unknown is the safe trust-boundary type.
        parsedInput = JSON.parse(tracker.inputText) as unknown;
      } catch {
        parsedInput = undefined;
      }

      const found = _getToolPart(message, trackers, chunk.toolCallId);
      if (!found) return state;
      message.parts[found.tracker.partIndex] = {
        ...toolBase(found.part),
        state: 'input-streaming',
        input: parsedInput,
      };
      return state;
    }
    case 'tool-input-available': {
      const found = _getToolPart(message, trackers, chunk.toolCallId);
      if (!found) return state;
      message.parts[found.tracker.partIndex] = {
        ...toolBase(found.part),
        state: 'input-available',
        input: chunk.input,
      };
      return state;
    }
    case 'tool-input-error': {
      const found = _getToolPart(message, trackers, chunk.toolCallId);
      if (found) {
        message.parts[found.tracker.partIndex] = {
          ...toolBase(found.part),
          state: 'output-error',
          input: chunk.input,
          errorText: chunk.errorText,
        };
      } else {
        const partIndex = message.parts.length;
        message.parts.push({
          ...toolBase(chunk),
          state: 'output-error',
          input: chunk.input,
          errorText: chunk.errorText,
        });
        trackers.tools.set(chunk.toolCallId, { partIndex, inputText: '' });
      }
      return state;
    }
  }
};

// ---------------------------------------------------------------------------
// Tool output transitions
// ---------------------------------------------------------------------------

const _foldToolOutput = (
  state: VercelProjection,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'tool-output-available' | 'tool-output-error' | 'tool-output-denied' | 'tool-approval-request' }
  >,
  messageId: string,
): VercelProjection => {
  const message = _ensureMessage(state, messageId);
  const trackers = _ensureTrackers(state, messageId);

  const found = _getToolPart(message, trackers, chunk.toolCallId);
  if (!found) return state;

  message.parts[found.tracker.partIndex] = transitionToolPart(found.part, chunk);
  return state;
};

// ---------------------------------------------------------------------------
// File / source content parts
// ---------------------------------------------------------------------------

const _foldContentPart = (
  state: VercelProjection,
  chunk: Extract<AI.UIMessageChunk, { type: 'file' | 'source-url' | 'source-document' }>,
  messageId: string,
): VercelProjection => {
  const message = _ensureMessage(state, messageId);

  switch (chunk.type) {
    case 'file': {
      message.parts.push({ type: 'file', mediaType: chunk.mediaType, url: chunk.url });
      return state;
    }
    case 'source-url': {
      message.parts.push(
        stripUndefined({
          type: 'source-url' as const,
          sourceId: chunk.sourceId,
          url: chunk.url,
          title: chunk.title,
        }),
      );
      return state;
    }
    case 'source-document': {
      message.parts.push(
        stripUndefined({
          type: 'source-document' as const,
          sourceId: chunk.sourceId,
          mediaType: chunk.mediaType,
          title: chunk.title,
          filename: chunk.filename,
        }),
      );
      return state;
    }
  }
};

// ---------------------------------------------------------------------------
// data-* parts
// ---------------------------------------------------------------------------

const _foldDataPart = (
  state: VercelProjection,
  chunk: Extract<AI.UIMessageChunk, { type: `data-${string}` }>,
  messageId: string,
): VercelProjection => {
  if (chunk.transient) return state;

  const message = _ensureMessage(state, messageId);

  // CAST: chunk.type is `data-${string}` which satisfies DataUIPart, but
  // TypeScript cannot verify the template literal matches a specific
  // UIMessagePart variant at the type level.
  const dataPart = stripUndefined({
    type: chunk.type,
    id: chunk.id,
    data: chunk.data,
  }) as AI.UIMessage['parts'][number];

  if (chunk.id !== undefined) {
    const idx = message.parts.findIndex((p) => p.type === chunk.type && 'id' in p && p.id === chunk.id);
    if (idx !== -1) {
      message.parts[idx] = dataPart;
      return state;
    }
  }

  message.parts.push(dataPart);
  return state;
};

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------

/**
 * Extract the UIMessage list from a projection for Tree population.
 * Consumed message-ids (tool-resolution wire messages whose payload was
 * folded onto a prior assistant) are filtered out so no Tree node is
 * created for them.
 * @param projection - Projection produced by `init` + repeated `fold` calls.
 * @returns The visible UIMessages, in publication order.
 */
export const getMessages = (projection: VercelProjection): AI.UIMessage[] => {
  if (projection.consumedCodecMessageIds.size === 0) return projection.messages;
  return projection.messages.filter((m) => !projection.consumedCodecMessageIds.has(m.id));
};

// ---------------------------------------------------------------------------
// dropMessages
// ---------------------------------------------------------------------------

/**
 * Whether a conflict key (see `_conflictKeyOf`) pertains to a dropped message
 * or one of its tool calls, and so must be pruned alongside the message.
 *
 * Conflict keys are `<prefix>:<rest>`. Which identity `rest` carries depends
 * on the prefix: message-level keys carry the codec-message-id; tool-state
 * keys carry the toolCallId; text/reasoning stream keys carry
 * `<codec-message-id>:<stream-id>` (the codec-message-id is everything up to
 * the last colon). Matching on whole segments avoids the stale high-water-mark
 * trap: leaving a dropped message's conflict serials behind would suppress a
 * later re-publish of the same key after the prune.
 * @param key - The conflict key from `projection.conflictSerials`.
 * @param droppedCodecMessageIds - Codec-message-ids being dropped.
 * @param droppedToolCallIds - Tool-call ids owned by the dropped messages.
 * @returns True when the key should be removed.
 */
const _conflictKeyReferencesDropped = (
  key: string,
  droppedCodecMessageIds: ReadonlySet<string>,
  droppedToolCallIds: ReadonlySet<string>,
): boolean => {
  const firstColon = key.indexOf(':');
  if (firstColon === -1) return false;
  const prefix = key.slice(0, firstColon);
  const rest = key.slice(firstColon + 1);
  switch (prefix) {
    case 'user-msg':
    case 'finish':
    case 'message-metadata': {
      return droppedCodecMessageIds.has(rest);
    }
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end': {
      // `rest` is `<codec-message-id>:<stream-id>`. Both segments are
      // colon-free in every path the SDK produces (codec-message-ids are
      // UUIDs or the caller's UIMessage.id; stream-ids are the chunk's `id`),
      // so the last colon delimits the stream-id and everything before it is
      // the codec-message-id.
      const lastColon = rest.lastIndexOf(':');
      const codecMessageId = lastColon === -1 ? rest : rest.slice(0, lastColon);
      return droppedCodecMessageIds.has(codecMessageId);
    }
    case 'tool-approval':
    case 'tool-output':
    case 'tool-input-start':
    case 'tool-input-available':
    case 'tool-input-error': {
      return droppedToolCallIds.has(rest);
    }
    default: {
      return false;
    }
  }
};

/**
 * Remove the given codec messages — and all reducer bookkeeping keyed to
 * them — from the projection. The Tree calls this to evict a deposed
 * invocation's content on a winner flip, and to evict a Run's content on
 * `delete`, now that one projection is shared across every Run.
 *
 * Prunes, for each dropped id: the `messages` entry; its `trackers`; its
 * `consumedCodecMessageIds` membership; any `pendingToolResolutions` whose
 * consumed wire id or toolCallId belongs to a dropped message; and every
 * `conflictSerials` high-water-mark keyed to the message or one of its tool
 * calls (so a later re-publish for the same key is not wrongly suppressed).
 *
 * Mutates and returns `projection`. Unknown ids are ignored.
 * @param projection - Projection to mutate.
 * @param codecMessageIds - Wire `x-ably-codec-message-id`s to evict.
 * @returns The same projection reference, mutated.
 */
export const dropMessages = (projection: VercelProjection, codecMessageIds: string[]): VercelProjection => {
  if (codecMessageIds.length === 0) return projection;
  const dropSet = new Set(codecMessageIds);

  // Tool-state conflict keys (tool-output / tool-approval / tool-input-*) are
  // keyed by toolCallId, not codec-message-id. Collect the toolCallIds owned
  // by the dropped messages so their conflict serials are pruned too.
  const droppedToolCallIds = new Set<string>();
  for (const message of projection.messages) {
    if (!dropSet.has(message.id)) continue;
    for (const part of message.parts) {
      if (part.type === 'dynamic-tool') droppedToolCallIds.add(part.toolCallId);
    }
  }

  projection.messages = projection.messages.filter((m) => !dropSet.has(m.id));

  for (const id of dropSet) {
    projection.trackers.delete(id);
    projection.consumedCodecMessageIds.delete(id);
  }

  for (const key of projection.conflictSerials.keys()) {
    if (_conflictKeyReferencesDropped(key, dropSet, droppedToolCallIds)) {
      projection.conflictSerials.delete(key);
    }
  }

  projection.pendingToolResolutions = projection.pendingToolResolutions.filter(
    (p) => !dropSet.has(p.consumedCodecMessageId) && !droppedToolCallIds.has(p.toolCallId),
  );

  return projection;
};
