/**
 * Vercel AI SDK reducer.
 *
 * Pure `(init, fold)` over the Vercel TEvent union. Folds chunks and
 * codec-local events (user-message, tool-approval) into a VercelProjection
 * holding `UIMessage[]` plus internal stream-tracker state.
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
 */

import type * as AI from 'ai';

import type { ReducerMeta } from '../../core/codec/types.js';
import { stripUndefined } from '../../utils.js';
import type { ToolApprovalEvent, UserMessageEvent, VercelEvent } from './events.js';
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

/** Per-msgId tracking state for in-progress streams within a UIMessage. */
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
  /** Per-msgId tracker state for streamed parts. Internal — do not access. */
  trackers: Map<string, MessageTrackers>;
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
      return _foldUserMessage(state, event);
    }
    case 'ait-tool-approval': {
      return _foldToolApproval(state, event);
    }
    default: {
      return _foldChunk(state, event, meta);
    }
  }
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
 * @param meta - Transport-derived metadata (used for events keyed by msg-id).
 * @returns The conflict key, or `undefined` if the event is additive / independent.
 */
const _conflictKeyOf = (event: VercelEvent, meta: ReducerMeta): string | undefined => {
  switch (event.type) {
    case 'ait-user-message': {
      return `user-msg:${event.message.id}`;
    }
    case 'ait-tool-approval': {
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
    // or wipe accumulated text. Keyed by (msg-id, stream-id).
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end': {
      return `${event.type}:${meta.messageId ?? ''}:${event.id}`;
    }

    // Message-level markers, keyed by msg-id.
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

const _foldUserMessage = (state: VercelProjection, event: UserMessageEvent): VercelProjection => {
  const existingIdx = state.messages.findIndex((m) => m.id === event.message.id);
  if (existingIdx === -1) {
    state.messages.push(event.message);
  } else {
    state.messages[existingIdx] = event.message;
  }
  return state;
};

const _foldToolApproval = (state: VercelProjection, event: ToolApprovalEvent): VercelProjection => {
  for (const message of state.messages) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i];
      if (part?.type === 'dynamic-tool' && part.toolCallId === event.toolCallId) {
        message.parts[i] = transitionToolPart(part, {
          type: event.approved ? 'tool-approval-request' : 'tool-output-denied',
          toolCallId: event.toolCallId,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          // CAST: transitionToolPart accepts the wider tool-approval/denied chunk union;
          // we synthesize a minimal record here that carries only the fields it reads.
        } as Parameters<typeof transitionToolPart>[1]);
        return state;
      }
    }
  }
  // Orphan — drop silently
  return state;
};

// ---------------------------------------------------------------------------
// UIMessageChunk fold
// ---------------------------------------------------------------------------

const _foldChunk = (state: VercelProjection, chunk: AI.UIMessageChunk, meta: ReducerMeta): VercelProjection => {
  const messageId = meta.messageId;
  if (messageId === undefined) {
    // Without a target msg-id, a chunk has nowhere to land. Drop.
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

    case 'tool-output-available':
    case 'tool-output-error':
    case 'tool-output-denied':
    case 'tool-approval-request': {
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
      // The wire HEADER_MSG_ID (carried via `meta.messageId`) is the
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
 * @param projection - Projection produced by `init` + repeated `fold` calls.
 * @returns The projection's `messages` array (live reference).
 */
export const getMessages = (projection: VercelProjection): AI.UIMessage[] => projection.messages;
