/**
 * Transport header builder.
 *
 * Single source of truth for which transport headers every transport
 * message carries. Used by the agent session (addMessages, pipe) and by
 * the client session (optimistic message stamping).
 */

import {
  EVENT_RUN_END,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../constants.js';
import type { RunEndReason, RunLifecycleEvent } from './types.js';

/**
 * Build the standard transport header set for a message.
 * @param opts - The header values to include.
 * @param opts.role - Message role (e.g. "user", "assistant").
 * @param opts.runId - Run correlation ID.
 * @param opts.codecMessageId - Message identity — the wire `codec-message-id` for this message.
 * @param opts.runClientId - ClientId of the run initiator.
 * @param opts.parent - Preceding message's codec-message-id (for branching).
 * @param opts.forkOf - Forked user-prompt's codec-message-id (for edits — creates a Run-level fork sibling).
 * @param opts.regenerates - Assistant codec-message-id this run regenerates. Stamps
 *   `msg-regenerate`. Distinct from `forkOf`: regenerate is a
 *   continuation of the prior run (no Run-level fork), with the message
 *   replacement resolved at projection extraction time.
 * @param opts.invocationId - Invocation correlation ID. Set on the user-prompt message so the agent can locate the prompt by invocation.
 * @param opts.inputClientId - ClientId of the input event (the `ai-input`) that
 *   drove the current invocation. The agent reads it from the publisher's
 *   Ably-level `clientId` on the matched input event and re-stamps it on its
 *   own publishes (run lifecycle + outputs). Differs from `runClientId` on
 *   continuation invocations driven by an input from a non-owner.
 * @param opts.inputEventId - Per-event identifier. Set on each client-published user-prompt message; the invocation body's `inputEventIds` lists the ids the agent should look up.
 * @param opts.inputCodecMessageId - The codec-message-id of the input event that
 *   triggered the current invocation (the one whose `event-id` matched the
 *   invocation's `inputEventId`). The agent re-stamps it on every event it
 *   publishes for the invocation (run lifecycle + outputs), mirroring
 *   `inputClientId`, so the client can correlate any of those events back to
 *   the originating input by the id it owned at send time.
 * @param opts.runContinue - When `true`, stamps `run-continue: 'true'` to mark
 *   the message as a continuation user-message (e.g. a tool-resolution publish under
 *   a suspended run), distinguishing it from a fresh user-prompt that opens a new run.
 * @returns A headers record with the transport headers set.
 */
export const buildTransportHeaders = (opts: {
  role: string;
  runId: string;
  codecMessageId: string;
  runClientId?: string;
  parent?: string;
  forkOf?: string;
  regenerates?: string;
  invocationId?: string;
  inputClientId?: string;
  inputCodecMessageId?: string;
  inputEventId?: string;
  runContinue?: boolean;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_ROLE]: opts.role,
    [HEADER_RUN_ID]: opts.runId,
    [HEADER_CODEC_MESSAGE_ID]: opts.codecMessageId,
  };
  if (opts.runClientId !== undefined) h[HEADER_RUN_CLIENT_ID] = opts.runClientId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.regenerates) h[HEADER_MSG_REGENERATE] = opts.regenerates;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.inputClientId !== undefined) h[HEADER_INPUT_CLIENT_ID] = opts.inputClientId;
  if (opts.inputCodecMessageId !== undefined) h[HEADER_INPUT_CODEC_MESSAGE_ID] = opts.inputCodecMessageId;
  if (opts.inputEventId) h[HEADER_EVENT_ID] = opts.inputEventId;
  if (opts.runContinue) h[HEADER_RUN_CONTINUE] = 'true';
  return h;
};

/**
 * Parse an inbound run-lifecycle Ably message into a {@link RunLifecycleEvent}.
 *
 * Single source of truth for turning the wire run-lifecycle message `name`,
 * transport headers, and channel serial into the structured lifecycle event
 * the Tree consumes. Used by the client decode loop (live) and the View's
 * history replay so both build the event identically.
 * @param name - The inbound Ably message `name`.
 * @param headers - Transport headers from the inbound Ably message.
 * @param serial - Ably channel serial of the message, or `undefined` for an
 *   optimistic local event. Stamped onto the returned event.
 * @returns The lifecycle event, or `undefined` when `name` is not a
 *   run-lifecycle event name or the message carries no `run-id`.
 */
export const parseRunLifecycle = (
  name: string,
  headers: Record<string, string>,
  serial: string | undefined,
): RunLifecycleEvent | undefined => {
  const runId = headers[HEADER_RUN_ID];
  if (!runId) return undefined;

  const clientId = headers[HEADER_RUN_CLIENT_ID] ?? '';

  if (name === EVENT_RUN_START) {
    const parent = headers[HEADER_PARENT];
    const forkOf = headers[HEADER_FORK_OF];
    const regenerates = headers[HEADER_MSG_REGENERATE];
    const isContinuation = headers[HEADER_RUN_CONTINUE] === 'true';
    return {
      type: 'start',
      runId,
      clientId,
      serial,
      invocationId: headers[HEADER_INVOCATION_ID] ?? '',
      ...(parent !== undefined && { parent }),
      ...(forkOf !== undefined && { forkOf }),
      ...(regenerates !== undefined && { regenerates }),
      ...(isContinuation && { isContinuation: true }),
    };
  }

  if (name === EVENT_RUN_SUSPEND) {
    return { type: 'suspend', runId, clientId, serial, invocationId: headers[HEADER_INVOCATION_ID] ?? '' };
  }

  if (name === EVENT_RUN_END) {
    // CAST: agent always writes a valid RunEndReason; default to 'complete' for robustness.
    const reason = (headers[HEADER_RUN_REASON] ?? 'complete') as RunEndReason;
    return { type: 'end', runId, clientId, serial, invocationId: headers[HEADER_INVOCATION_ID] ?? '', reason };
  }

  return undefined;
};
