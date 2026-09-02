/**
 * Wire-data shapes and runtime guards for the tool payloads whose `data`
 * envelope is JSON-parsed from the network (a trust boundary). The guards
 * validate the typed envelope fields; tool-defined `output`/`input` stay
 * unconstrained. Shared by the output and input descriptor tables.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { VercelToolOutputChunk } from './events.js';

/** Wire format for the agent-side `tool-input-error` chunk data payload. */
export interface ToolInputErrorWireData {
  /** The provider's error text for the failed input stream, when it supplied one. */
  errorText?: string;
  /** The partial tool input at failure — tool-defined, carried unconstrained. */
  input?: unknown;
}

/** Wire format for the agent-side `tool-output-available` chunk data payload. */
export interface ToolOutputAvailableWireData {
  /** The tool's output — tool-defined, carried unconstrained. */
  output?: unknown;
}

/** Wire format for the agent-side `tool-output-error` chunk data payload. */
export interface AgentToolOutputErrorWireData {
  /** The provider's error text for the failed tool call, when it supplied one. */
  errorText?: string;
}

// Narrow JSON-parsed wire data to a record. The encoder is expected to publish
// an object for these payloads, but a malformed publish could carry a primitive
// or null — callers fall back to field defaults when these guards reject.
const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === 'object' && data !== null;

// Validate that `data` is a record whose named field is absent or a string. The
// optional-string check for the typed error fields below lives here once so the
// guards can't drift. No `as` needed: `isRecord` narrows `data` to a record, so
// string-key indexing is well-typed.
const isRecordWithOptionalString = (data: unknown, key: string): boolean =>
  isRecord(data) && (data[key] === undefined || typeof data[key] === 'string');

/**
 * Coerce wire `data` to a string, falling back to `''` for any non-string
 * payload — the defensive read for descriptors whose data is plain text.
 * @param data - The inbound wire data.
 * @returns The string payload, or `''` when the data is not a string.
 */
export const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

/**
 * Validate wire `data` as a tool-output chunk body (the `chunk` input's whole
 * payload rides the data envelope verbatim). The typed envelope fields are
 * checked — a `tool-output-*` `type` and a string `toolCallId` — while the
 * tool-defined `output` / error detail stays unconstrained. Malformed data
 * throws: the receive path drops the one message and surfaces the error,
 * rather than handing a consumer a body the provider's reducer would choke on.
 * @param data - The inbound wire data.
 * @returns The validated chunk body.
 * @throws {Ably.ErrorInfo} InvalidArgument when the data is not a tool-output chunk.
 */
export const readToolOutputChunkWireData = (data: unknown): VercelToolOutputChunk => {
  if (
    isRecord(data) &&
    typeof data.type === 'string' &&
    data.type.startsWith('tool-output-') &&
    typeof data.toolCallId === 'string'
  ) {
    // CAST: wire trust boundary — the envelope fields are validated above; the
    // chunk's remaining fields are the provider's own and stay unconstrained.
    return data as unknown as VercelToolOutputChunk;
  }
  throw new Ably.ErrorInfo(
    'unable to decode input; chunk body is not a tool-output chunk',
    ErrorCode.InvalidArgument,
    400,
  );
};

export const isToolInputErrorWireData = (data: unknown): data is ToolInputErrorWireData =>
  isRecordWithOptionalString(data, 'errorText');

// The sole field `output` is tool-defined and intentionally unconstrained, so
// this asserts only that the payload is an object envelope.
export const isToolOutputAvailableWireData = (data: unknown): data is ToolOutputAvailableWireData => isRecord(data);

// Validates the typed `errorText` field.
export const isAgentToolOutputErrorWireData = (data: unknown): data is AgentToolOutputErrorWireData =>
  isRecordWithOptionalString(data, 'errorText');
