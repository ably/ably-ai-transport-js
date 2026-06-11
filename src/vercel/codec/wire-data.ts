/**
 * Wire-data shapes and runtime guards for the tool payloads whose `data`
 * envelope is JSON-parsed from the network (a trust boundary). The guards
 * validate the typed envelope fields; tool-defined `output`/`input` stay
 * unconstrained. Shared by the output and input descriptor tables.
 */

/** Wire format for the agent-side `tool-input-error` chunk data payload. */
export interface ToolInputErrorWireData {
  errorText?: string;
  input?: unknown;
}

/** Wire format for the `tool-output-available` (agent) / `tool-result` (client) data payload. */
export interface ToolOutputAvailableWireData {
  output?: unknown;
}

/** Wire format for the agent-side `tool-output-error` chunk data payload. */
export interface AgentToolOutputErrorWireData {
  errorText?: string;
}

/** Wire format for the client-side `tool-result-error` input data payload. */
export interface ClientToolResultErrorWireData {
  message?: string;
}

// Narrow JSON-parsed wire data to a record. The encoder is expected to publish
// an object for these payloads, but a malformed publish could carry a primitive
// or null — callers fall back to field defaults when these guards reject.
const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === 'object' && data !== null;

// Validates the typed `errorText` field; `input` is tool-defined and
// intentionally left unconstrained.
/**
 * Coerce wire `data` to a string, falling back to `''` for any non-string
 * payload — the defensive read for descriptors whose data is plain text.
 * @param data - The inbound wire data.
 * @returns The string payload, or `''` when the data is not a string.
 */
export const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

export const isToolInputErrorWireData = (data: unknown): data is ToolInputErrorWireData =>
  isRecord(data) && (data.errorText === undefined || typeof data.errorText === 'string');

// The sole field `output` is tool-defined and intentionally unconstrained, so
// this asserts only that the payload is an object envelope.
export const isToolOutputAvailableWireData = (data: unknown): data is ToolOutputAvailableWireData => isRecord(data);

// Validates the typed `errorText` field.
export const isAgentToolOutputErrorWireData = (data: unknown): data is AgentToolOutputErrorWireData =>
  isRecord(data) && (data.errorText === undefined || typeof data.errorText === 'string');

// Validates the typed `message` field.
export const isClientToolResultErrorWireData = (data: unknown): data is ClientToolResultErrorWireData =>
  isRecord(data) && (data.message === undefined || typeof data.message === 'string');
