/**
 * Transport header builder.
 *
 * Single source of truth for which transport headers every transport
 * message carries. Used by the agent session (pipe) and by
 * the client session (optimistic message stamping).
 */

import * as Ably from 'ably';

import {
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INPUT_EVENT_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { RunEndReason, RunLifecycleEvent } from './types.js';

/**
 * Build the standard transport header set for a message.
 * @param opts - The header values to include.
 * @param opts.role - Message role (e.g. "user", "assistant").
 * @param opts.runId - Run correlation ID, or `undefined` for a fresh client
 *   input (the agent mints run-ids, so it is not known synchronously). Omitted
 *   from the headers when undefined; a continuation still carries the known run-id.
 * @param opts.codecMessageId - Message identity — the wire `codec-message-id` for this message.
 * @param opts.runClientId - ClientId of the run initiator.
 * @param opts.parent - Preceding message's codec-message-id (for branching).
 * @param opts.forkOf - Forked user-prompt's codec-message-id (for edits — creates a Run-level fork sibling).
 * @param opts.regenerates - Assistant codec-message-id this run regenerates. Stamps
 *   `msg-regenerate`. Distinct from `forkOf`: regenerate is a
 *   continuation of the prior run (no Run-level fork), with the message
 *   replacement resolved at projection extraction time.
 * @param opts.invocationId - Agent-minted invocation id. Stamped by the agent on every event it publishes for the invocation (run lifecycle + outputs) so the client can observe it; not set by the client on the input.
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
 * @param opts.triggeringInputEventId - The `event-id` of the input event that
 *   triggered the current invocation. The agent re-stamps it on its outputs as
 *   `input-event-id`, mirroring `inputCodecMessageId` but at event-id
 *   granularity: it is per-send, so concurrent continuations of one suspended
 *   run carry distinct values (their own triggering tool-result's event-id),
 *   which is what lets a per-request output stream and the codec separate them.
 *   Distinct from `inputEventId` above, which sets THIS message's own
 *   `event-id` on a client input.
 * @returns A headers record with the transport headers set.
 */
export const buildTransportHeaders = (opts: {
  role: string;
  runId?: string;
  codecMessageId: string;
  runClientId?: string;
  parent?: string;
  forkOf?: string;
  regenerates?: string;
  invocationId?: string;
  inputClientId?: string;
  inputCodecMessageId?: string;
  inputEventId?: string;
  triggeringInputEventId?: string;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_ROLE]: opts.role,
    [HEADER_CODEC_MESSAGE_ID]: opts.codecMessageId,
  };
  if (opts.runId !== undefined) h[HEADER_RUN_ID] = opts.runId;
  if (opts.runClientId !== undefined) h[HEADER_RUN_CLIENT_ID] = opts.runClientId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.regenerates) h[HEADER_MSG_REGENERATE] = opts.regenerates;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.inputClientId !== undefined) h[HEADER_INPUT_CLIENT_ID] = opts.inputClientId;
  if (opts.inputCodecMessageId !== undefined) h[HEADER_INPUT_CODEC_MESSAGE_ID] = opts.inputCodecMessageId;
  if (opts.inputEventId) h[HEADER_EVENT_ID] = opts.inputEventId;
  if (opts.triggeringInputEventId !== undefined) h[HEADER_INPUT_EVENT_ID] = opts.triggeringInputEventId;
  return h;
};

/**
 * Build the transport header set for a run-lifecycle event (run-start,
 * run-resume, run-suspend, run-end). Single source of truth for lifecycle
 * header stamping, mirroring {@link buildTransportHeaders} for the
 * message-carrier path. Every field except `runId`/`runClientId` is optional
 * and omitted when not provided.
 *
 * A resume suppresses the structural `parent` / `forkOf` / `regenerates`
 * headers — the caller passes them only for a fresh run-start. `reason` is
 * stamped only on run-end.
 * @param opts - The lifecycle header values to include.
 * @param opts.runId - The run's id.
 * @param opts.runClientId - ClientId of the run initiator (empty string when unknown).
 * @param opts.parent - Structural parent codec-message-id (fresh run-start only).
 * @param opts.forkOf - Forked user-prompt codec-message-id (fresh run-start only).
 * @param opts.regenerates - Regenerated assistant codec-message-id (fresh run-start only).
 * @param opts.invocationId - Agent-minted invocation id; carried on every lifecycle event.
 * @param opts.inputClientId - ClientId of the triggering input event.
 * @param opts.inputCodecMessageId - Codec-message-id of the triggering input event.
 * @param opts.reason - Terminal reason; stamped on run-end only.
 * @param opts.errorCode - Numeric error code stamped as `error-code` on
 *   run-end. Set only when the run ended in error and the agent supplied an
 *   error to surface; gives codec-agnostic consumers a baseline failure detail.
 * @param opts.errorMessage - Error message stamped as `error-message` on
 *   run-end. Paired with `errorCode`; set under the same condition.
 * @returns A headers record with the lifecycle headers set.
 */
export const buildLifecycleHeaders = (opts: {
  runId: string;
  runClientId: string;
  parent?: string;
  forkOf?: string;
  regenerates?: string;
  invocationId?: string;
  inputClientId?: string;
  inputCodecMessageId?: string;
  reason?: RunEndReason;
  errorCode?: number;
  errorMessage?: string;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_RUN_ID]: opts.runId,
    [HEADER_RUN_CLIENT_ID]: opts.runClientId,
  };
  if (opts.reason !== undefined) h[HEADER_RUN_REASON] = opts.reason;
  if (opts.parent !== undefined) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf !== undefined) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.regenerates !== undefined) h[HEADER_MSG_REGENERATE] = opts.regenerates;
  if (opts.invocationId !== undefined) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.inputClientId !== undefined) h[HEADER_INPUT_CLIENT_ID] = opts.inputClientId;
  if (opts.inputCodecMessageId !== undefined) h[HEADER_INPUT_CODEC_MESSAGE_ID] = opts.inputCodecMessageId;
  if (opts.errorCode !== undefined) h[HEADER_ERROR_CODE] = String(opts.errorCode);
  if (opts.errorMessage !== undefined) h[HEADER_ERROR_MESSAGE] = opts.errorMessage;
  return h;
};

/** The four run-lifecycle Ably message names. */
type RunLifecycleName =
  | typeof EVENT_RUN_START
  | typeof EVENT_RUN_SUSPEND
  | typeof EVENT_RUN_RESUME
  | typeof EVENT_RUN_END;

/**
 * Whether an Ably message `name` is one of the run-lifecycle event names
 * (run-start / run-suspend / run-resume / run-end). Single source of truth for
 * the classification both decode loops and the agent's history scan use to
 * route lifecycle wires away from the codec decoder. Narrows `name` to a
 * lifecycle name so callers can pass it straight to {@link parseRunLifecycle}.
 * @param name - The inbound Ably message `name`, or undefined.
 * @returns True when `name` is a run-lifecycle event name.
 */
export const isRunLifecycleName = (name: string | undefined): name is RunLifecycleName =>
  name === EVENT_RUN_START || name === EVENT_RUN_SUSPEND || name === EVENT_RUN_RESUME || name === EVENT_RUN_END;

/**
 * Reconstruct the terminal `Ably.ErrorInfo` for a run that ended in error, from
 * its run-end transport headers. Reads the `error-code` / `error-message`
 * headers the agent stamps (see {@link buildLifecycleHeaders}); falls back to a
 * generic code/message when a run ended in error without detail. Single source
 * of truth for the header→ErrorInfo derivation, shared by the client session's
 * `on('error')` emit and the Tree's `RunInfo.error`.
 * @param headers - Transport headers from the inbound run-end message.
 * @returns The reconstructed terminal error.
 */
export const buildRunEndError = (headers: Record<string, string>): Ably.ErrorInfo => {
  const codeRaw = headers[HEADER_ERROR_CODE];
  const parsedCode = codeRaw === undefined ? Number.NaN : Number(codeRaw);
  const code = Number.isFinite(parsedCode) ? parsedCode : ErrorCode.SessionSubscriptionError;
  const message = headers[HEADER_ERROR_MESSAGE] ?? 'agent reported an error';
  // 5-digit codes encode their HTTP status in the leading 3 digits; otherwise 500.
  const statusCode = code >= 10000 && code < 60000 ? Math.floor(code / 100) : 500;
  return new Ably.ErrorInfo(message, code, statusCode);
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
 * @param timestamp - Ably server timestamp (epoch ms) of the message, or
 *   `undefined` for an optimistic local event. Stamped onto the returned
 *   event; drives the Tree's event-log retention clock.
 * @returns The lifecycle event, or `undefined` when `name` is not a
 *   run-lifecycle event name or the message carries no `run-id`.
 */
export const parseRunLifecycle = (
  name: string,
  headers: Record<string, string>,
  serial: string | undefined,
  timestamp: number | undefined,
): RunLifecycleEvent | undefined => {
  const runId = headers[HEADER_RUN_ID];
  if (!runId) return undefined;

  const clientId = headers[HEADER_RUN_CLIENT_ID] ?? '';
  const stamped = timestamp === undefined ? {} : { timestamp };

  if (name === EVENT_RUN_START) {
    const parent = headers[HEADER_PARENT];
    const forkOf = headers[HEADER_FORK_OF];
    const regenerates = headers[HEADER_MSG_REGENERATE];
    return {
      type: 'start',
      runId,
      clientId,
      serial,
      invocationId: headers[HEADER_INVOCATION_ID] ?? '',
      ...stamped,
      ...(parent !== undefined && { parent }),
      ...(forkOf !== undefined && { forkOf }),
      ...(regenerates !== undefined && { regenerates }),
    };
  }

  if (name === EVENT_RUN_SUSPEND) {
    return { type: 'suspend', runId, clientId, serial, invocationId: headers[HEADER_INVOCATION_ID] ?? '', ...stamped };
  }

  if (name === EVENT_RUN_RESUME) {
    return { type: 'resume', runId, clientId, serial, invocationId: headers[HEADER_INVOCATION_ID] ?? '', ...stamped };
  }

  if (name === EVENT_RUN_END) {
    // CAST: agent always writes a valid RunEndReason; default to 'complete' for robustness.
    const reason = (headers[HEADER_RUN_REASON] ?? 'complete') as RunEndReason;
    const invocationId = headers[HEADER_INVOCATION_ID] ?? '';
    if (reason === 'error') {
      return {
        type: 'end',
        runId,
        clientId,
        serial,
        invocationId,
        reason,
        ...stamped,
        error: buildRunEndError(headers),
      };
    }
    return { type: 'end', runId, clientId, serial, invocationId, reason, ...stamped };
  }

  return undefined;
};
