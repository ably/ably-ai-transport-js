/**
 * Vercel AI SDK reducer.
 *
 * Pure `(init, fold)` over the `VercelInput | VercelOutput` union. Folds
 * input variants (user-message, tool-result, tool-result-error,
 * tool-approval-response) and `UIMessageChunk` outputs into a
 * VercelProjection holding `UIMessage[]` plus internal stream-tracker
 * state.
 *
 * The reducer is stateless: every fold is `(state, event, meta) → state'`,
 * with no instance state. Mutation in place is allowed — the projection
 * is single-owner.
 *
 * The reducer does not dedup or reorder. The transport sequences events
 * canonically — ascending by wire serial across messages, in decode order
 * within a wire — and delivers each exactly once, so the reducer folds
 * unconditionally. Last-writer-wins for events competing over the same
 * logical state (e.g. two `tool-output-available` for one `toolCallId`)
 * falls out of fold order: the highest-serial event folds last.
 *
 * Client-published tool resolutions (`ToolResult`, `ToolResultError`,
 * `ToolApprovalResponse`) carry `codecMessageId` targeting the assistant
 * they amend; the reducer applies the resolution onto that assistant's
 * tool part directly. If the assistant has not yet arrived in
 * the projection (out-of-order delivery), the resolution is buffered in
 * `pendingToolResolutions` and re-evaluated on each subsequent fold.
 *
 * This file is the reducer's public facade and dispatch: `init`,
 * `getMessages`, `fold`, and the output-chunk router. The per-concern fold
 * logic lives in the sibling `fold-*` modules over a shared `reducer-state`
 * base; the import graph is an acyclic DAG rooted here.
 */

import type * as AI from 'ai';

import type { CodecEvent, CodecMessage, ReducerMeta } from '../../core/codec/index.js';
import type { VercelInput, VercelOutput } from './events.js';
import { foldContentPart } from './fold-content.js';
import { foldDataPart, isDataChunk } from './fold-data.js';
import {
  foldClientToolResult,
  foldClientToolResultError,
  foldToolApprovalResponse,
  foldUserMessage,
  retryPendingResolutions,
} from './fold-input.js';
import { foldLifecycle } from './fold-lifecycle.js';
import { foldTextOrReasoning } from './fold-text.js';
import { foldToolInput } from './fold-tool-input.js';
import { foldToolOutput } from './fold-tool-output.js';
import type { VercelProjection } from './reducer-state.js';

// ---------------------------------------------------------------------------
// fold
// ---------------------------------------------------------------------------

/**
 * Fold one input or output event into the projection. Mutates and returns
 * `state`.
 *
 * The transport invokes `fold` exactly once per event, in canonical order,
 * so the reducer folds unconditionally — no dedup or high-water-mark here.
 * Competing events resolve by order (the highest-serial event folds last
 * and wins). Orphan events (e.g. tool-output for an unknown toolCallId) are
 * dropped silently inside the per-variant fold helpers.
 * @param state - Projection to fold into (may be mutated in place).
 * @param event - Input or output event to fold.
 * @param meta - Transport-derived metadata (serial, optional messageId).
 * @returns The same projection reference, possibly mutated.
 */
export const fold = (
  state: VercelProjection,
  event: CodecEvent<VercelInput, VercelOutput>,
  meta: ReducerMeta,
): VercelProjection => {
  if (event.direction === 'input') {
    const input = event.event;
    switch (input.kind) {
      case 'user-message': {
        foldUserMessage(state, input.message, meta);
        break;
      }
      case 'regenerate': {
        // Regenerate input — wire-only signal. Carries no projection state;
        // the agent reads `target` / `parent` from the wire headers via
        // the input-event lookup path. No fold work to do here.
        break;
      }
      case 'tool-result': {
        foldClientToolResult(state, input);
        break;
      }
      case 'tool-result-error': {
        foldClientToolResultError(state, input);
        break;
      }
      case 'tool-approval-response': {
        foldToolApprovalResponse(state, input);
        break;
      }
    }
  } else {
    foldChunk(state, event.event, meta);
  }

  // Re-evaluate pending tool resolutions in case the just-folded event
  // produced the assistant they were waiting on. Cheap when the list is
  // empty (the common case).
  if (state.pendingToolResolutions.length > 0) {
    retryPendingResolutions(state);
  }

  return state;
};

// ---------------------------------------------------------------------------
// UIMessageChunk dispatch
// ---------------------------------------------------------------------------

const foldChunk = (state: VercelProjection, chunk: VercelOutput, meta: ReducerMeta): VercelProjection => {
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
      return foldLifecycle(state, chunk, messageId);
    }

    case 'text-start':
    case 'text-delta':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-delta':
    case 'reasoning-end': {
      return foldTextOrReasoning(state, chunk, messageId);
    }

    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-input-available':
    case 'tool-input-error': {
      return foldToolInput(state, chunk, messageId);
    }

    case 'tool-output-available':
    case 'tool-output-error':
    case 'tool-output-denied':
    case 'tool-approval-request': {
      return foldToolOutput(state, chunk, messageId);
    }

    case 'file':
    case 'source-url':
    case 'source-document': {
      return foldContentPart(state, chunk, messageId);
    }

    default: {
      // Everything the cases above don't claim: the `data-*` family folds as a
      // data part; any other chunk type the installed `ai` major carries that
      // this codec does not project is dropped.
      return isDataChunk(chunk) ? foldDataPart(state, chunk, messageId) : state;
    }
  }
};

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------

/**
 * Extract the UIMessage list from a projection, each paired with its
 * codec-message-id. Client-published tool resolutions amend existing
 * assistants in place via `kind: 'tool-result'` etc. — they never
 * materialise as their own UIMessage in the projection, so no filtering is
 * needed here.
 * @param projection - Projection produced by `init` + repeated `fold` calls.
 * @returns The visible messages with their codec-message-ids, in publication order.
 */
export const getMessages = (projection: VercelProjection): CodecMessage<AI.UIMessage>[] => projection.messages;

export { init, type VercelProjection } from './reducer-state.js';
