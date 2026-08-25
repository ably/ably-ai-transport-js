/**
 * Transport header builder.
 *
 * Single source of truth for which transport headers every transport
 * message carries. Used by the agent's output path (pipe) and by
 * the client's optimistic message stamping.
 */

import * as Ably from 'ably';

import {
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  EVENT_STEP_END,
  EVENT_STEP_START,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_EVENT_ID,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_TRANSPORT_MESSAGE_ID,
  HEADER_INPUT_TRANSPORT_MESSAGE_IDS,
  HEADER_INVOCATION_ID,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STEP_CLIENT_ID,
  HEADER_STEP_ID,
  HEADER_STEP_REASON,
  HEADER_STEP_START_SERIAL,
  HEADER_TRANSPORT_MESSAGE_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { RunEndReason, RunLifecycleEvent, StepEndReason, StepLifecycleEvent } from './types.js';

/**
 * Build the standard transport header set for a message.
 * @param opts - The header values to include.
 * @param opts.role - Message role (e.g. "user", "assistant").
 * @param opts.runId - Run correlation ID, or `undefined` for a fresh client
 *   input (the agent mints run-ids, so it is not known synchronously). Omitted
 *   from the headers when undefined; a continuation still carries the known run-id.
 * @param opts.transportMessageId - Message identity — the wire `transport-message-id` for this message.
 * @param opts.runClientId - ClientId of the run initiator.
 * @param opts.invocationId - Agent-minted invocation id. Stamped by the agent on every event it publishes for the invocation (run lifecycle + outputs) so the client can observe it; not set by the client on the input.
 * @param opts.inputClientId - ClientId of the input event (the `ai-input`) that
 *   drove the current invocation. The agent reads it from the publisher's
 *   Ably-level `clientId` on the matched input event and re-stamps it on its
 *   own publishes (run lifecycle + outputs). Differs from `runClientId` on
 *   continuation invocations driven by an input from a non-owner.
 * @param opts.inputEventId - Per-event identifier. Set on each client-published user-prompt message; the invocation body's `inputEventIds` lists the ids the agent should look up.
 * @param opts.inputTransportMessageId - The transport-message-id of the input event that
 *   triggered the current invocation (the one whose `event-id` matched the
 *   invocation's `inputEventId`). The agent re-stamps it on every event it
 *   publishes for the invocation (run lifecycle + outputs), mirroring
 *   `inputClientId`, so the client can correlate any of those events back to
 *   the originating input by the id it owned at send time.
 * @param opts.stepId - The owning step's id, when the output is published within
 *   a `RunStep`. See {@link HEADER_STEP_ID}.
 * @param opts.stepStartSerial - The owning step attempt's `step-start-serial` (the channel
 *   serial of its `ai-step-start`), back-referenced on the output so it
 *   attributes to the right attempt. See {@link HEADER_STEP_START_SERIAL}.
 * @param opts.stepClientId - The owning step's client (the innermost of the
 *   three concentric client-identity scopes; stamped as `step-client-id`).
 *   Stamped on every output of the step (initial + appends + close) so an
 *   output self-attributes to its step's participant even if that attempt's
 *   `ai-step-start` never arrived — mirroring the `step-id` / `step-start-serial`
 *   invariant.
 * @returns A headers record with the transport headers set.
 */
export const buildTransportHeaders = (opts: {
  role: string;
  runId?: string;
  transportMessageId: string;
  runClientId?: string;
  invocationId?: string;
  inputClientId?: string;
  inputTransportMessageId?: string;
  inputEventId?: string;
  stepId?: string;
  stepStartSerial?: string;
  stepClientId?: string;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_ROLE]: opts.role,
    [HEADER_TRANSPORT_MESSAGE_ID]: opts.transportMessageId,
  };
  if (opts.runId !== undefined) h[HEADER_RUN_ID] = opts.runId;
  if (opts.runClientId !== undefined) h[HEADER_RUN_CLIENT_ID] = opts.runClientId;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.inputClientId !== undefined) h[HEADER_INPUT_CLIENT_ID] = opts.inputClientId;
  if (opts.inputTransportMessageId !== undefined) h[HEADER_INPUT_TRANSPORT_MESSAGE_ID] = opts.inputTransportMessageId;
  if (opts.inputEventId) h[HEADER_EVENT_ID] = opts.inputEventId;
  if (opts.stepId !== undefined) h[HEADER_STEP_ID] = opts.stepId;
  if (opts.stepStartSerial !== undefined) h[HEADER_STEP_START_SERIAL] = opts.stepStartSerial;
  if (opts.stepClientId !== undefined) h[HEADER_STEP_CLIENT_ID] = opts.stepClientId;
  return h;
};

/**
 * Build the transport header set for a run-lifecycle event (run-start,
 * run-resume, run-suspend, run-end). Single source of truth for lifecycle
 * header stamping, mirroring {@link buildTransportHeaders} for the
 * message-carrier path. Every field except `runId`/`runClientId` is optional
 * and omitted when not provided.
 *
 * `reason` is stamped only on run-end.
 * @param opts - The lifecycle header values to include.
 * @param opts.runId - The run's id.
 * @param opts.runClientId - ClientId of the run initiator (empty string when unknown).
 * @param opts.invocationId - Agent-minted invocation id; carried on every lifecycle event.
 * @param opts.inputClientId - ClientId of the triggering input event.
 * @param opts.inputTransportMessageId - Transport-message-id of the triggering input event.
 * @param opts.reason - Terminal reason; stamped on run-end only.
 * @param opts.consideredInputIds - Transport-message-ids of every input the run's
 *   output considered (trigger + stamped steers), stamped as the
 *   `input-transport-message-ids` bracket receipt on run-suspend / run-end.
 *   Omitted when absent or empty.
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
  invocationId?: string;
  inputClientId?: string;
  inputTransportMessageId?: string;
  reason?: RunEndReason;
  consideredInputIds?: string[];
  errorCode?: number;
  errorMessage?: string;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_RUN_ID]: opts.runId,
    [HEADER_RUN_CLIENT_ID]: opts.runClientId,
  };
  if (opts.reason !== undefined) h[HEADER_RUN_REASON] = opts.reason;
  if (opts.invocationId !== undefined) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.inputClientId !== undefined) h[HEADER_INPUT_CLIENT_ID] = opts.inputClientId;
  if (opts.inputTransportMessageId !== undefined) h[HEADER_INPUT_TRANSPORT_MESSAGE_ID] = opts.inputTransportMessageId;
  if (opts.consideredInputIds !== undefined && opts.consideredInputIds.length > 0) {
    h[HEADER_INPUT_TRANSPORT_MESSAGE_IDS] = JSON.stringify(opts.consideredInputIds);
  }
  if (opts.errorCode !== undefined) h[HEADER_ERROR_CODE] = String(opts.errorCode);
  if (opts.errorMessage !== undefined) h[HEADER_ERROR_MESSAGE] = opts.errorMessage;
  return h;
};

/**
 * Parse a JSON-array-of-transport-message-ids header — the encoding shared by the
 * per-output `steer-transport-message-ids` stamp and the run-bracket
 * `input-transport-message-ids` receipt. Returns `undefined` when the header is
 * absent, malformed, or empty after filtering non-strings, so a bad value
 * degrades to "no header" rather than poisoning the consumer.
 * @param value - The raw header value, or undefined when unset.
 * @returns The parsed transport-message-ids, or undefined.
 */
export const parseTransportMessageIdsHeader = (value: string | undefined): string[] | undefined => {
  if (value === undefined) return undefined;
  try {
    // CAST: trust boundary. The agent stamps a JSON array of strings, and a
    // malformed value degrades to "no header" for this message.
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const ids = parsed.filter((id): id is string => typeof id === 'string');
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
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
 * headers the agent stamps (see {@link buildLifecycleHeaders}); falls back to
 * `RunResponseStreamFailed` — the code the agent stamps for run failures — when a run
 * ended in error without detail. Single source of truth for the
 * header→ErrorInfo derivation, so every consumer of an errored run-end
 * reconstructs the same error.
 * @param headers - Transport headers from the inbound run-end message.
 * @returns The reconstructed terminal error.
 */
export const buildRunEndError = (headers: Record<string, string>): Ably.ErrorInfo => {
  const codeRaw = headers[HEADER_ERROR_CODE];
  const parsedCode = codeRaw === undefined ? Number.NaN : Number(codeRaw);
  const code = Number.isFinite(parsedCode) ? parsedCode : ErrorCode.RunResponseStreamFailed;
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
 * receive-stream consumers get. Used by the live decode loop and history
 * replay so both build the event identically.
 * @param name - The inbound Ably message `name`.
 * @param headers - Transport headers from the inbound Ably message.
 * @param serial - Ably channel serial of the message, or `undefined` for an
 *   optimistic local event. Stamped onto the returned event.
 * @param timestamp - Ably server timestamp (epoch ms) of the message, or
 *   `undefined` for an optimistic local event. Stamped onto the returned
 *   event.
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
    // The triggering input's transport-message-id, already stamped on the wire by
    // `buildLifecycleHeaders`. Carried onto the 'start' event so a consumer
    // can correlate the run back to its triggering input — the client
    // transport resolves its `publishInput` runId watches from it.
    const inputTransportMessageId = headers[HEADER_INPUT_TRANSPORT_MESSAGE_ID];
    return {
      type: 'start',
      runId,
      clientId,
      serial,
      invocationId: headers[HEADER_INVOCATION_ID] ?? '',
      ...stamped,
      ...(inputTransportMessageId !== undefined && { inputTransportMessageId }),
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

/**
 * Build the transport header set for a step-lifecycle event (step-start /
 * step-end). Mirrors {@link buildLifecycleHeaders} for the step layer.
 * `run-id` and `step-id` are always present; `step-reason` is stamped on
 * step-end only. `step-start-serial` is the back-reference to the serial of the
 * `ai-step-start` an `ai-step-end` closes — so it is supplied on step-end and
 * omitted on step-start, whose own channel serial IS the attempt's identity.
 *
 * The invocation correlation (`invocation-id`) and the three concentric
 * client-identity scopes (`run-client-id` ⊃ `input-client-id` ⊃
 * `step-client-id`) are stamped on BOTH step-start and step-end whenever
 * supplied, so a consumer can attribute either step event to its run,
 * invocation, and step participant. An empty-string value still stamps the
 * header (an unknown owner is conveyed as the empty string, mirroring
 * `buildLifecycleHeaders`'s `run-client-id`); an omitted (`undefined`) value
 * is left off entirely.
 * @param opts - The step header values to include.
 * @param opts.runId - The run the step belongs to.
 * @param opts.stepId - The step's id (stable across retry attempts).
 * @param opts.stepStartSerial - Back-reference to the serial of the `ai-step-start`
 *   this event closes; set on step-end, omitted on step-start.
 * @param opts.invocationId - The invocation-id the step is published under (correlation).
 * @param opts.runClientId - The run owner's clientId (the outermost client scope).
 * @param opts.invocationClientId - The current invocation's input publisher (stamped as `input-client-id`, the middle scope).
 * @param opts.stepClientId - The step's client (the innermost scope; the participant whose incorporated input shapes the step).
 * @param opts.reason - Terminal reason; stamped on step-end only.
 * @returns A headers record with the step headers set.
 */
export const buildStepHeaders = (opts: {
  runId: string;
  stepId: string;
  stepStartSerial?: string;
  invocationId?: string;
  runClientId?: string;
  invocationClientId?: string;
  stepClientId?: string;
  reason?: StepEndReason;
}): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_RUN_ID]: opts.runId,
    [HEADER_STEP_ID]: opts.stepId,
  };
  if (opts.stepStartSerial !== undefined) h[HEADER_STEP_START_SERIAL] = opts.stepStartSerial;
  if (opts.invocationId !== undefined) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.runClientId !== undefined) h[HEADER_RUN_CLIENT_ID] = opts.runClientId;
  // `invocationClientId` rides the existing `input-client-id` wire name: it is
  // the publisher of the triggering input, which equals the POST issuer's id
  // only when that issuer published the input event it points at — the common
  // case. See HEADER_INPUT_CLIENT_ID.
  if (opts.invocationClientId !== undefined) h[HEADER_INPUT_CLIENT_ID] = opts.invocationClientId;
  if (opts.stepClientId !== undefined) h[HEADER_STEP_CLIENT_ID] = opts.stepClientId;
  if (opts.reason !== undefined) h[HEADER_STEP_REASON] = opts.reason;
  return h;
};

/** The two step-lifecycle Ably message names. */
type StepLifecycleName = typeof EVENT_STEP_START | typeof EVENT_STEP_END;

/**
 * Whether an Ably message `name` is one of the step-lifecycle event names
 * (step-start / step-end). Single source of truth for the classification the
 * decode loops use to route step lifecycle wires away from
 * the codec decoder, mirroring {@link isRunLifecycleName}. Narrows `name` so
 * callers can pass it straight to {@link parseStepLifecycle}.
 * @param name - The inbound Ably message `name`, or undefined.
 * @returns True when `name` is a step-lifecycle event name.
 */
export const isStepLifecycleName = (name: string | undefined): name is StepLifecycleName =>
  name === EVENT_STEP_START || name === EVENT_STEP_END;

/**
 * Parse an inbound step-lifecycle Ably message into a {@link StepLifecycleEvent}.
 *
 * Mirrors {@link parseRunLifecycle} for the step layer: turns the wire message
 * `name`, transport headers, and channel serial into the structured event
 * receive-stream consumers get. Used by both the live decode loop and history
 * replay so they build the event identically.
 * @param name - The inbound Ably message `name`.
 * @param headers - Transport headers from the inbound Ably message.
 * @param serial - Ably channel serial of the message, or `undefined` for an
 *   optimistic local event.
 * @param timestamp - Ably server timestamp (epoch ms), or `undefined` for an
 *   optimistic local event.
 * @returns The step-lifecycle event, or `undefined` when `name` is not a
 *   step-lifecycle name, the message is missing a `run-id` or `step-id`, or a
 *   step-end is missing its `step-start-serial` back-reference.
 */
export const parseStepLifecycle = (
  name: string,
  headers: Record<string, string>,
  serial: string | undefined,
  timestamp: number | undefined,
): StepLifecycleEvent | undefined => {
  const runId = headers[HEADER_RUN_ID];
  const stepId = headers[HEADER_STEP_ID];
  if (!runId || !stepId) return undefined;

  const stamped = timestamp === undefined ? {} : { timestamp };
  // The invocation correlation + the three concentric client-identity scopes,
  // each defaulting to the empty string when the wire didn't carry it (mirrors
  // `parseRunLifecycle`'s clientId/invocationId handling). `invocationClientId`
  // is read from the `input-client-id` wire name it shares.
  const clientScopes = {
    invocationId: headers[HEADER_INVOCATION_ID] ?? '',
    runClientId: headers[HEADER_RUN_CLIENT_ID] ?? '',
    invocationClientId: headers[HEADER_INPUT_CLIENT_ID] ?? '',
    stepClientId: headers[HEADER_STEP_CLIENT_ID] ?? '',
  };

  if (name === EVENT_STEP_START) {
    // A step-start's identity is its own serial, so there is no back-ref to read.
    return { type: 'step-start', runId, stepId, ...clientScopes, serial, ...stamped };
  }

  if (name === EVENT_STEP_END) {
    // A step-end back-references its step-start's serial. Without it the event
    // cannot be attributed to an attempt, so drop it (mirrors run-id/step-id).
    const stepStartSerial = headers[HEADER_STEP_START_SERIAL];
    if (!stepStartSerial) return undefined;
    // CAST: agent always writes a valid StepEndReason; default to 'complete' for robustness.
    const reason = (headers[HEADER_STEP_REASON] ?? 'complete') as StepEndReason;
    return { type: 'step-end', runId, stepId, stepStartSerial, ...clientScopes, serial, reason, ...stamped };
  }

  return undefined;
};
