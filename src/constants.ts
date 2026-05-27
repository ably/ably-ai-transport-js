/**
 * Shared constants used by both codec and transport layers.
 *
 * Header constants define the `x-ably-*` wire protocol. Message and event
 * name constants define the session lifecycle signals on the channel.
 *
 * These live at the top level (not in codec/ or transport/) because both
 * layers need them — the codec core reads/writes stream and status headers,
 * while the transport layer reads/writes run, cancel, and role headers.
 */

// ---------------------------------------------------------------------------
// Stream headers (used by codec encoder/decoder core)
// ---------------------------------------------------------------------------

/** Header: whether this Ably message uses streaming (message appends) or is discrete. Always "true" or "false". */
export const HEADER_STREAM = 'x-ably-stream';

/** Header: lifecycle status of a streamed message. Only set when x-ably-stream is "true". One of "streaming", "complete", or "cancelled". */
export const HEADER_STATUS = 'x-ably-status';

/** Header: stream identity. Set by the encoder on every streamed message; read by the decoder to correlate streams. */
export const HEADER_STREAM_ID = 'x-ably-stream-id';

/** Header: marks a message as a discrete message part (from writeMessages). Set by publishDiscreteBatch; not set on lifecycle events from publishDiscrete. */
export const HEADER_DISCRETE = 'x-ably-discrete';

// ---------------------------------------------------------------------------
// Identity headers (used by transport for run correlation)
// ---------------------------------------------------------------------------

/** Header: run correlation ID. Set on every message in a run. */
export const HEADER_RUN_ID = 'x-ably-run-id';

/** Header: invocation correlation ID. Set on the client-published user message; identifies a specific invocation under a run. */
export const HEADER_INVOCATION_ID = 'x-ably-invocation-id';

/**
 * Header: per-event identifier stamped by the client on every
 * client-published event in a send — user-message events AND amend
 * events (tool-approval responses, client tool outputs). Distinct from
 * `x-ably-codec-message-id` so it survives edits/retries that reuse the same
 * codec-message-id, and so amend events that target an existing message can
 * carry their own per-send identity. The invocation body lists every
 * eventId the agent must observe on the channel before starting LLM
 * work — see `Run.start()`'s prompt lookup.
 */
export const HEADER_EVENT_ID = 'x-ably-event-id';

/** Header: message identity. Assigned per message (user or assistant). Used for optimistic reconciliation on the client. */
export const HEADER_CODEC_MESSAGE_ID = 'x-ably-codec-message-id';

/** Header: clientId of the user who initiated the run. Set by the server on stream messages. */
export const HEADER_RUN_CLIENT_ID = 'x-ably-run-client-id';

/**
 * Header: clientId of the input event (the `ai-input`) that drove the
 * current invocation. The agent reads the publisher's Ably-level `clientId`
 * from the triggering input event on the channel and re-stamps it as
 * `x-ably-input-client-id` on every event it publishes for that invocation
 * (run lifecycle and assistant outputs). May differ from
 * `x-ably-run-client-id` on continuation invocations driven by an input
 * from a non-owner (e.g. a tool-result publish from a different client).
 * Not stamped on `ai-input` events themselves — the wire publisher's
 * Ably `clientId` already conveys that.
 */
export const HEADER_INPUT_CLIENT_ID = 'x-ably-input-client-id';

/** Header: message role (e.g. "user", "assistant"). */
export const HEADER_ROLE = 'x-ably-role';

// ---------------------------------------------------------------------------
// Fork / branching headers
// ---------------------------------------------------------------------------

/** Header: the codec-message-id of the immediately preceding message in this branch. */
export const HEADER_PARENT = 'x-ably-parent';

/** Header: the codec-message-id of the message this one replaces (creates a fork). */
export const HEADER_FORK_OF = 'x-ably-fork-of';

/**
 * Header: the msg-id of the assistant message this run regenerates.
 *
 * Stamped on the regenerate wire (and echoed on `run-start`) when the
 * client requested a regeneration. The Tree treats regenerates as
 * continuations of the prior run (parentRunId chain), not as forks; the
 * View consults this header to resolve the message-level sibling group
 * and to drop the regenerated message from earlier Runs in the visible
 * chain (Spec: AIT-CT13d).
 */
export const HEADER_MSG_REGENERATE = 'x-ably-msg-regenerate';

// ---------------------------------------------------------------------------
// Run lifecycle headers
// ---------------------------------------------------------------------------

/** Header: reason a run ended (on ai-run-end messages). */
export const HEADER_RUN_REASON = 'x-ably-run-reason';

/**
 * Header: marks a `run-start` event as a continuation of an already-started
 * run rather than the first start. Value: the literal string `'true'`.
 * Continuation runs share the original run's id but represent a subsequent
 * invocation (e.g. tool-result follow-up). Consumers can use this to skip
 * re-threading the run into the tree or to surface a distinct lifecycle
 * signal.
 */
export const HEADER_RUN_CONTINUE = 'x-ably-run-continue';

// ---------------------------------------------------------------------------
// Run-end error headers (set on `ai-run-end` when `x-ably-run-reason: error`)
// ---------------------------------------------------------------------------

/** Header: numeric error code accompanying an `ai-run-end` with reason `error`. */
export const HEADER_ERROR_CODE = 'x-ably-error-code';

/** Header: human-readable error message accompanying an `ai-run-end` with reason `error`. */
export const HEADER_ERROR_MESSAGE = 'x-ably-error-message';

// ---------------------------------------------------------------------------
// Message / event names
// ---------------------------------------------------------------------------

/** Message name: client->agent cancel intent. Targets a specific run via the `x-ably-run-id` header. */
export const EVENT_CANCEL = 'ai-cancel';

/** Message name: server publishes this to signal a run has started. */
export const EVENT_RUN_START = 'ai-run-start';

/** Message name: server publishes this to signal a run has ended. */
export const EVENT_RUN_END = 'ai-run-end';

/**
 * Message name: every agent-published codec event (text, reasoning, tool calls,
 * tool outputs, lifecycle helpers, file / source parts, data-* chunks) rides
 * this single wire name. The codec event's own `type` is carried in the
 * `x-domain-type` domain header so the decoder can dispatch.
 */
export const EVENT_AI_OUTPUT = 'ai-output';

/**
 * Message name: every client-published codec event (user-message parts,
 * tool-approval responses, regenerate signals) rides this single wire
 * name. The codec event's own `type` is carried in the `x-domain-type`
 * domain header so the decoder can dispatch.
 */
export const EVENT_AI_INPUT = 'ai-input';

// ---------------------------------------------------------------------------
// Domain header prefix (used by codec implementations)
// ---------------------------------------------------------------------------

/** Prefix for domain-specific headers. Distinguishes codec-layer headers from transport `x-ably-*` headers. */
export const DOMAIN_HEADER_PREFIX = 'x-domain-';
