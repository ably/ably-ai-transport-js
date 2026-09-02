/**
 * Cancel-signal envelope.
 *
 * The client publishes an `ai-cancel` signal and the agent reads it back off
 * the channel. This module is the single source of truth for the cancel wire
 * shape — which transport header identifies the target run, and how it is
 * read — so the publish side (the client transport's `cancel`) and the read
 * side (the agent transport's cancel routing) cannot drift on the header
 * name.
 *
 * A cancel targets its run by `run-id` only. A client that has not yet
 * learned the run-id awaits `PublishInputResult.runId` (resolved from the
 * `ai-run-start` naming its input) before cancelling; a cancel that still
 * races the agent's `openRun` is buffered by run-id on the agent side.
 *
 * The envelope also stamps a per-cancel `event-id` so channel rewind redelivers
 * the cancel to a per-request / serverless agent that attaches after it was
 * published. Cancels are idempotent, so the read side ignores the `event-id` —
 * it is purely a rewind-delivery aid, not part of the target.
 */

import type * as Ably from 'ably';

import { EVENT_CANCEL, HEADER_EVENT_ID, HEADER_RUN_ID } from '../../constants.js';
import { getTransportHeaders } from '../../utils.js';

/** The identifier a cancel signal targets its run by. */
export interface CancelTarget {
  /** The run-id to cancel. */
  runId: string;
}

/**
 * Build the `ai-cancel` Ably message for a cancel target. Stamps the target's
 * run-id plus a fresh per-cancel `event-id` for rewind redelivery (see the
 * module header). Pass the result straight to `channel.publish`.
 * @param target - The run to cancel.
 * @returns The Ably message to publish.
 */
export const buildCancelMessage = (target: CancelTarget): Ably.Message => ({
  name: EVENT_CANCEL,
  extras: {
    ai: {
      transport: {
        // Stamp a per-cancel event-id so channel rewind redelivers this cancel
        // to an agent that attaches after it was published.
        [HEADER_EVENT_ID]: crypto.randomUUID(),
        [HEADER_RUN_ID]: target.runId,
      },
    },
  },
});

/**
 * Read the cancel target off an inbound `ai-cancel` message — the inverse of
 * {@link buildCancelMessage}. The `event-id` is deliberately not read: cancels
 * are idempotent, so it carries no routing meaning. `runId` is `undefined` for
 * a malformed cancel; the caller drops it.
 * @param msg - The inbound `ai-cancel` Ably message.
 * @returns The run the cancel targets, or `undefined` when malformed.
 */
export const readCancelTarget = (msg: Ably.InboundMessage): { runId: string | undefined } => ({
  runId: getTransportHeaders(msg)[HEADER_RUN_ID],
});
