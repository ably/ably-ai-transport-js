/**
 * Vercel AI SDK reducer.
 *
 * Assembled from the shared spine ({@link defineReducer}): the spine owns the
 * entry store, the direction/drop dispatch, the well-known `user-message` /
 * `regenerate` routing, and `getMessages`; this module supplies the
 * Vercel-specific fold bodies. Folds input variants (user-message, tool-result,
 * tool-result-error, tool-approval-response) and `UIMessageChunk` outputs into a
 * VercelProjection holding `UIMessage[]` plus internal stream-tracker state.
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
 * tool part directly. If the assistant has not yet arrived in the projection
 * (out-of-order delivery), the resolution is buffered in the projection's
 * `extra.pending` state object and re-evaluated after every subsequent fold via
 * `afterFold`.
 *
 * This file is the reducer's public facade: the `defineReducer` call and the
 * output-chunk router. The per-concern fold logic lives in the sibling `fold-*`
 * modules over a shared `reducer-state` base; the import graph is an acyclic
 * DAG rooted here.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';

import { defineReducer } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { VercelInput, VercelOutput } from './events.js';
import { foldContentPart } from './fold-content.js';
import { foldDataPart } from './fold-data.js';
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
import type { MessageTrackers, VercelCtx, VercelExtra } from './reducer-state.js';

// ---------------------------------------------------------------------------
// UIMessageChunk dispatch
// ---------------------------------------------------------------------------

/**
 * Route one output chunk to the fold module owning its part concern. The
 * spine has already dropped chunks with no codec-message-id and resolved the
 * target entry into `ctx`, so this only dispatches by `chunk.type`.
 * @param ctx - The fold-body capability object.
 * @param chunk - The output chunk to route.
 */
const foldChunk = (ctx: VercelCtx, chunk: VercelOutput): void => {
  switch (chunk.type) {
    case 'start':
    case 'start-step':
    case 'finish-step':
    case 'finish':
    case 'abort':
    case 'error':
    case 'message-metadata': {
      foldLifecycle(ctx, chunk);
      return;
    }

    case 'text-start':
    case 'text-delta':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-delta':
    case 'reasoning-end': {
      foldTextOrReasoning(ctx, chunk);
      return;
    }

    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-input-available':
    case 'tool-input-error': {
      foldToolInput(ctx, chunk);
      return;
    }

    case 'tool-output-available':
    case 'tool-output-error':
    case 'tool-output-denied':
    case 'tool-approval-request': {
      foldToolOutput(ctx, chunk);
      return;
    }

    case 'file':
    case 'source-url':
    case 'source-document': {
      foldContentPart(ctx, chunk);
      return;
    }

    default: {
      if (chunk.type.startsWith('data-')) {
        foldDataPart(ctx, chunk);
      }
      return;
    }
  }
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const reducer = defineReducer<
  VercelInput,
  VercelOutput,
  AI.UIMessage,
  MessageTrackers,
  AI.UIMessage['role'],
  VercelExtra
>({
  createEntry: (role, codecMessageId) => ({
    message: { id: codecMessageId, role, parts: [] },
    tracker: { text: new Map(), reasoning: new Map(), tools: new Map() },
  }),
  initExtra: () => ({ pending: [] }),
  foldOutput: foldChunk,
  foldUserMessage: foldUserMessage,
  foldInput: (ctx, event) => {
    switch (event.kind) {
      case 'tool-result': {
        foldClientToolResult(ctx, event);
        return;
      }
      case 'tool-result-error': {
        foldClientToolResultError(ctx, event);
        return;
      }
      case 'tool-approval-response': {
        foldToolApprovalResponse(ctx, event);
        return;
      }
      default: {
        // The spine routes `user-message` and `regenerate` itself, so only
        // the tool-resolution kinds reach here; anything else is an input
        // the codec does not model and must fail loudly.
        throw new Ably.ErrorInfo(
          `unable to fold input; unmodelled Vercel input kind '${event.kind}'`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
    }
  },
  afterFold: (ctx) => {
    // Re-evaluate buffered tool resolutions in case the just-folded event
    // produced the assistant they were waiting on. Cheap when the buffer is
    // empty (the common case).
    if (ctx.extra.pending.length > 0) retryPendingResolutions(ctx);
  },
});

/** The Vercel reducer's `init`: a fresh empty projection. */
export const init = reducer.init;
/** The Vercel reducer's `fold`: folds one input/output event into the projection. */
export const fold = reducer.fold;
/** The Vercel reducer's `getMessages`: the reconstructed messages, by reference. */
export const getMessages = reducer.getMessages;

export { type VercelProjection } from './reducer-state.js';
