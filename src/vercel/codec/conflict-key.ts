/**
 * Conflict-key derivation.
 *
 * The conflict key scopes the reducer's per-key high-water-mark dedup to
 * genuine conflicts (events competing for the same logical state) rather than
 * to every event in the stream. Additive and independent events have no key
 * and are always folded.
 */

import type { CodecEvent, ReducerMeta } from '../../core/codec/index.js';
import type { VercelInput, VercelOutput } from './events.js';

/**
 * Derive a per-event conflict key, or `undefined` if the event doesn't
 * compete with any other event for shared state. Used by `fold` to scope
 * the high-water-mark check to genuine conflicts (e.g. two
 * `tool-output-available` for the same `toolCallId`) rather than to every
 * event in the stream.
 * @param event - The direction-tagged event being folded.
 * @param meta - Transport-derived metadata (used for events keyed by codec-message-id).
 * @returns The conflict key, or `undefined` if the event is additive / independent.
 */
export const conflictKeyOf = (event: CodecEvent<VercelInput, VercelOutput>, meta: ReducerMeta): string | undefined => {
  if (event.direction === 'input') {
    const input = event.event;
    switch (input.kind) {
      case 'user-message': {
        // Dedup replays of the same wire part by codec-message-id + serial,
        // never by the domain `message.id`. The serial is part of the key
        // because one user message fans out into one wire event per part, all
        // sharing the codec-message-id — distinct parts must not compete,
        // while a replay of the same part (same serial) must drop so the
        // merge in foldUserMessage stays idempotent. Without a
        // codec-message-id there is nothing to correlate on, so the fold is
        // left unconditional.
        return meta.messageId === undefined ? undefined : `user-msg:${meta.messageId}:${meta.serial}`;
      }
      case 'tool-approval-response': {
        return `tool-approval:${input.payload.toolCallId}`;
      }
      // Client tool results compete for the same final state of the tool
      // call (against agent-side `tool-output-available`/`tool-output-error`
      // chunks and against `tool-output-denied`/`tool-approval-request`).
      // Highest serial wins. Shares the `tool-output:` namespace with the
      // agent-side chunks below.
      case 'tool-result':
      case 'tool-result-error': {
        return `tool-output:${input.payload.toolCallId}`;
      }
      case 'regenerate': {
        return undefined;
      }
    }
  }

  const output = event.event;
  switch (output.type) {
    // Tool-input state machine, keyed by toolCallId.
    case 'tool-input-start':
    case 'tool-input-available':
    case 'tool-input-error': {
      return `${output.type}:${output.toolCallId}`;
    }

    // All "tool-output-ish" output variants compete for the same final
    // state of the tool call. Shares the `tool-output:` namespace with
    // the client-published input variants above.
    case 'tool-output-available':
    case 'tool-output-error':
    case 'tool-output-denied':
    case 'tool-approval-request': {
      return `tool-output:${output.toolCallId}`;
    }

    // Per-stream start/end markers: duplicates would create phantom parts
    // or wipe accumulated text. Keyed by (codec-message-id, stream-id).
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end': {
      return `${output.type}:${meta.messageId ?? ''}:${output.id}`;
    }

    // Message-level markers, keyed by codec-message-id.
    case 'finish':
    case 'message-metadata': {
      return `${output.type}:${meta.messageId ?? ''}`;
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
