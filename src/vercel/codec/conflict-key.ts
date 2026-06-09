/**
 * Conflict-key derivation and input/output direction narrowing.
 *
 * The conflict key scopes the reducer's per-key high-water-mark dedup to
 * genuine conflicts (events competing for the same logical state) rather than
 * to every event in the stream. Additive and independent events have no key
 * and are always folded.
 */

import type { ReducerMeta } from '../../core/codec/types.js';
import type { VercelInput, VercelOutput } from './events.js';

/**
 * Narrow the union to TInput vs TOutput by the discriminator field name.
 * VercelInput variants carry `kind`; VercelOutput variants carry `type`.
 * @param event - The event to narrow.
 * @returns True when the event is a VercelInput, false for VercelOutput.
 */
export const isInput = (event: VercelInput | VercelOutput): event is VercelInput => 'kind' in event;

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
export const conflictKeyOf = (event: VercelInput | VercelOutput, meta: ReducerMeta): string | undefined => {
  if (isInput(event)) {
    switch (event.kind) {
      case 'user-message': {
        // Dedup re-publishes of the same user message by its wire
        // codec-message-id, never by the domain `message.id`. Without a
        // codec-message-id there is nothing to correlate on, so the fold
        // is left unconditional.
        return meta.messageId === undefined ? undefined : `user-msg:${meta.messageId}`;
      }
      case 'tool-approval-response': {
        return `tool-approval:${event.payload.toolCallId}`;
      }
      // Client tool results compete for the same final state of the tool
      // call (against agent-side `tool-output-available`/`tool-output-error`
      // chunks and against `tool-output-denied`/`tool-approval-request`).
      // Highest serial wins. Shares the `tool-output:` namespace with the
      // agent-side chunks below.
      case 'tool-result':
      case 'tool-result-error': {
        return `tool-output:${event.payload.toolCallId}`;
      }
      case 'regenerate': {
        return undefined;
      }
    }
  }

  switch (event.type) {
    // Tool-input state machine, keyed by toolCallId.
    case 'tool-input-start':
    case 'tool-input-available':
    case 'tool-input-error': {
      return `${event.type}:${event.toolCallId}`;
    }

    // All "tool-output-ish" output variants compete for the same final
    // state of the tool call. Shares the `tool-output:` namespace with
    // the client-published input variants above.
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
