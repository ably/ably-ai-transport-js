/**
 * steer-ordering — repositions unresponded steer messages within a run node's
 * flattened message list.
 *
 * A steer is a follow-up user message a client folds into an already-active
 * run. The run node's projection is rebuilt in canonical serial order, so a
 * steer whose wire serial is lower than the assistant output it should follow
 * sorts *before* that output. When the agent then builds its next inference
 * prompt from the run's messages, that prompt can end on an assistant message —
 * which the model rejects (no assistant-message prefill).
 *
 * The fix is minimal: leave every message in serial order except a steer no
 * output has responded to yet, which moves to the tail so the run ends on a
 * user message. A steer an output already responded to is left in place — the
 * responding output necessarily has a higher serial, so serial order already
 * places it correctly.
 */

import type { CodecMessage } from './session-codec.js';

/**
 * Resolves, per run, whether a message is a steer no output has responded to
 * yet. Supplied by the transport, which owns the steer bookkeeping the codec
 * cannot see (which folded-in user message is a steer, and whether an output
 * has stamped it as responded).
 */
export interface SteerOrdering {
  /**
   * Whether `codecMessageId` is a steer folded into `runId` that no output has
   * responded to yet. `false` for non-steer messages and for steers an output
   * has already responded to.
   * @param runId - The run the message belongs to.
   * @param codecMessageId - The message's codec-message-id.
   * @returns True iff the message is an as-yet-unresponded steer.
   */
  isUnrespondedSteer(runId: string, codecMessageId: string): boolean;
}

/**
 * Move every unresponded steer to the tail of a run node's flattened messages,
 * preserving the relative order of everything else (including responded steers
 * and multiple unresponded steers). Returns the input array unchanged when no
 * message is an unresponded steer, so the common fully-responded case is a
 * no-op.
 * @param messages - One run node's flattened messages, in serial order.
 * @param isUnrespondedSteer - Predicate identifying an unresponded steer by codec-message-id.
 * @returns The messages with unresponded steers deferred to the tail.
 */
export const deferUnrespondedSteers = <TMessage>(
  messages: CodecMessage<TMessage>[],
  isUnrespondedSteer: (codecMessageId: string) => boolean,
): CodecMessage<TMessage>[] => {
  const kept: CodecMessage<TMessage>[] = [];
  const deferred: CodecMessage<TMessage>[] = [];
  for (const message of messages) {
    if (isUnrespondedSteer(message.codecMessageId)) deferred.push(message);
    else kept.push(message);
  }
  return deferred.length === 0 ? messages : [...kept, ...deferred];
};
