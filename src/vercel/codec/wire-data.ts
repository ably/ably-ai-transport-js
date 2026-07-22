/**
 * Wire-data shapes and runtime guards for the tool payloads whose `data`
 * envelope is JSON-parsed from the network (a trust boundary). The guards
 * validate the typed envelope fields; tool-defined `output`/`input` stay
 * unconstrained. Shared by the output and input descriptor tables.
 */

import type * as AI from 'ai';

import type { CodecMessage } from '../../core/codec/index.js';
import type { ForkSeed } from './events.js';

/** Wire format for the agent-side `tool-input-error` chunk data payload. */
export interface ToolInputErrorWireData {
  errorText?: string;
  input?: unknown;
}

/** Wire format for the `tool-output-available` (agent) / `tool-result` (client) data payload. */
export interface ToolOutputAvailableWireData {
  output?: unknown;
  /** Fork-continuation reconstruction seed (client tool-result only); validated by {@link readForkSeedWireData}. */
  forkSeed?: unknown;
}

/** Wire format for the agent-side `tool-output-error` chunk data payload. */
export interface AgentToolOutputErrorWireData {
  errorText?: string;
}

/** Wire format for the client-side `tool-result-error` input data payload. */
export interface ClientToolResultErrorWireData {
  message?: string;
  /** Fork-continuation reconstruction seed (see {@link ToolOutputAvailableWireData}). */
  forkSeed?: unknown;
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
  isRecordWithOptionalString(data, 'errorText');

// The sole field `output` is tool-defined and intentionally unconstrained, so
// this asserts only that the payload is an object envelope.
export const isToolOutputAvailableWireData = (data: unknown): data is ToolOutputAvailableWireData => isRecord(data);

// Validates the typed `errorText` field.
export const isAgentToolOutputErrorWireData = (data: unknown): data is AgentToolOutputErrorWireData =>
  isRecordWithOptionalString(data, 'errorText');

// Validates the typed `message` field.
export const isClientToolResultErrorWireData = (data: unknown): data is ClientToolResultErrorWireData =>
  isRecordWithOptionalString(data, 'message');

/**
 * Extract and validate the fork-continuation `forkSeed` nested in a tool-result
 * / tool-result-error `data` envelope. Validates the seed is `{ messages:
 * Array }`; for each message validates `codecMessageId` is a string and
 * `message` is an object carrying a `parts` array, then FILTERS each message's
 * parts down to only objects with a string `type`.
 *
 * The filter is the trust-boundary hardening: the reducer's `isToolPart` reads
 * `part.type` UNGUARDED, so a malformed part (`{}`, `null`) would crash the
 * fold. Dropping malformed parts here guarantees only well-formed parts ever
 * reach the reducer. A message with no valid `codecMessageId` / `parts` is
 * dropped entirely; a malformed whole envelope yields `undefined` and the
 * descriptor decode omits the seed.
 * @param data - The JSON-parsed input `data` envelope.
 * @returns The validated, well-formed seed, or `undefined`.
 */
export const readForkSeedWireData = (data: unknown): ForkSeed | undefined => {
  if (!isRecord(data)) return undefined;
  const seed = data.forkSeed;
  if (!isRecord(seed) || !Array.isArray(seed.messages)) return undefined;
  const messages: CodecMessage<AI.UIMessage>[] = [];
  for (const entry of seed.messages) {
    if (!isRecord(entry) || typeof entry.codecMessageId !== 'string') continue;
    const message = entry.message;
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    // Drop any part that isn't an object with a string `type` — the malformed
    // shapes (`{}`, `null`) that would crash `isToolPart` downstream.
    const parts = message.parts.filter((p): p is Record<string, unknown> => isRecord(p) && typeof p.type === 'string');
    // CAST: `codecMessageId` is validated a string and the surviving parts are
    // objects with a string `type`; the rest of the message shape (id, role,
    // metadata, per-part fields) is tool/codec-defined and trusted at the wire
    // boundary (mirrors the unconstrained `output`).
    messages.push({ codecMessageId: entry.codecMessageId, message: { ...message, parts } as AI.UIMessage });
  }
  return { messages };
};
