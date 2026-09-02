/**
 * Cancel-signal envelope.
 *
 * The client publishes an `ai-cancel` signal and the agent reads it back off
 * the channel. This module is the single source of truth for the cancel wire
 * shape — which transport headers identify the target run, and how they are
 * read — so the publish side (the client transport's `cancel`) and the read
 * side (the agent transport's cancel routing) cannot drift on the header
 * names or which identifiers a cancel carries.
 *
 * A cancel targets its run by `run-id` (a continuation, whose run-id the client
 * already knows) and/or by `input-codec-message-id` (a fresh send, whose run-id
 * the agent mints at run-start — before then the client can only key the cancel
 * by the triggering input's codec-message-id). At least one is present.
 *
 * The envelope also stamps a per-cancel `event-id` so channel rewind redelivers
 * the cancel to a per-request / serverless agent that attaches after it was
 * published. Cancels are idempotent, so the read side ignores the `event-id` —
 * it is purely a rewind-delivery aid, not part of the target.
 */

import type * as Ably from 'ably';

import { EVENT_CANCEL, HEADER_EVENT_ID, HEADER_INPUT_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../constants.js';
import { getTransportHeaders } from '../../utils.js';

/**
 * The identifier(s) a cancel signal targets its run by. At least one of
 * `runId` / `inputCodecMessageId` must be set for the cancel to route.
 */
export interface CancelTarget {
  /** The run-id to cancel — set for continuations, whose run-id the caller knows. */
  runId?: string;
  /**
   * The triggering input's codec-message-id to cancel — set for fresh sends,
   * before the agent has minted (and echoed) the run-id.
   */
  inputCodecMessageId?: string;
}

/**
 * Build the `ai-cancel` Ably message for a cancel target. Stamps the target's
 * identifiers plus a fresh per-cancel `event-id` for rewind redelivery (see the
 * module header). Pass the result straight to `channel.publish`.
 * @param target - The run identifier(s) to cancel; at least one must be set.
 * @returns The Ably message to publish.
 */
export const buildCancelMessage = (target: CancelTarget): Ably.Message => {
  const headers: Record<string, string> = {
    // Stamp a per-cancel event-id so channel rewind redelivers this cancel to an
    // agent that attaches after it was published.
    [HEADER_EVENT_ID]: crypto.randomUUID(),
  };
  if (target.runId !== undefined) headers[HEADER_RUN_ID] = target.runId;
  if (target.inputCodecMessageId !== undefined) headers[HEADER_INPUT_CODEC_MESSAGE_ID] = target.inputCodecMessageId;

  return { name: EVENT_CANCEL, extras: { ai: { transport: headers } } };
};

/**
 * Read the cancel target off an inbound `ai-cancel` message — the inverse of
 * {@link buildCancelMessage}. The `event-id` is deliberately not read: cancels
 * are idempotent, so it carries no routing meaning. Either field may be
 * `undefined`; the caller treats both-undefined as a malformed cancel.
 * @param msg - The inbound `ai-cancel` Ably message.
 * @returns The run identifier(s) the cancel targets.
 */
export const readCancelTarget = (msg: Ably.InboundMessage): CancelTarget => {
  const headers = getTransportHeaders(msg);
  return {
    runId: headers[HEADER_RUN_ID],
    inputCodecMessageId: headers[HEADER_INPUT_CODEC_MESSAGE_ID],
  };
};
