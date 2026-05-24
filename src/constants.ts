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

/** Header: lifecycle status of a streamed message. Only set when x-ably-stream is "true". */
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
 * `x-ably-msg-id` so it survives edits/retries that reuse the same
 * msg-id, and so amend events that target an existing message can
 * carry their own per-send identity. The invocation body lists every
 * promptId the agent must observe on the channel before starting LLM
 * work — see `Run.start()`'s prompt lookup.
 */
export const HEADER_PROMPT_ID = 'x-ably-prompt-id';

/** Header: message identity. Assigned per message (user or assistant). Used for optimistic reconciliation on the client. */
export const HEADER_MSG_ID = 'x-ably-msg-id';

/** Header: clientId of the user who initiated the run. Set by the server on stream messages. */
export const HEADER_RUN_CLIENT_ID = 'x-ably-run-client-id';

/** Header: message role (e.g. "user", "assistant"). */
export const HEADER_ROLE = 'x-ably-role';

// ---------------------------------------------------------------------------
// Cancel headers
// ---------------------------------------------------------------------------

/** Header: cancel a specific run by ID. */
export const HEADER_CANCEL_RUN_ID = 'x-ably-cancel-run-id';

/** Header: cancel all runs belonging to the sender's clientId. */
export const HEADER_CANCEL_OWN = 'x-ably-cancel-own';

/** Header: cancel all runs on the channel. */
export const HEADER_CANCEL_ALL = 'x-ably-cancel-all';

/** Header: cancel all runs belonging to a specific clientId. */
export const HEADER_CANCEL_CLIENT_ID = 'x-ably-cancel-client-id';

/** Header: cancel a specific invocation by ID. */
export const HEADER_CANCEL_INVOCATION_ID = 'x-ably-cancel-invocation-id';

// ---------------------------------------------------------------------------
// Fork / branching headers
// ---------------------------------------------------------------------------

/** Header: the msg-id of the immediately preceding message in this branch. */
export const HEADER_PARENT = 'x-ably-parent';

/** Header: the msg-id of the message this one replaces (creates a fork). */
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

/**
 * Header: numeric error code on an `ai-run-end` event whose reason is
 * `error`. Stringified `Ably.ErrorInfo.code` value; consumers parse it back
 * to a number. Paired with {@link HEADER_ERROR_MESSAGE} to surface the
 * underlying failure to the client.
 */
export const HEADER_ERROR_CODE = 'x-ably-error-code';

/**
 * Header: human-readable error message on an `ai-run-end` event whose
 * reason is `error`. Paired with {@link HEADER_ERROR_CODE}.
 */
export const HEADER_ERROR_MESSAGE = 'x-ably-error-message';

/**
 * Header: optional HTTP-style status code on an `ai-run-end` event whose
 * reason is `error`. Stringified integer; omitted when the agent did not
 * supply one. Used by the client to populate
 * `Ably.ErrorInfo.statusCode` faithfully for custom (104xxx-style) codes
 * where the derivation from `code` is lossy.
 */
export const HEADER_ERROR_STATUS_CODE = 'x-ably-error-status-code';

// ---------------------------------------------------------------------------
// Message / event names
// ---------------------------------------------------------------------------

/** Message name: server publishes this to signal a run has started. */
export const EVENT_RUN_START = 'ai-run-start';

/** Message name: server publishes this to signal a run has ended. */
export const EVENT_RUN_END = 'ai-run-end';

/**
 * Message name: client→agent abort signal. Published by the client to
 * request that one or more runs be aborted. The agent reacts by aborting
 * its in-flight work and (eventually) publishing `ai-run-end` with
 * `reason: 'cancelled'`. Cancel scope is carried via the
 * `x-ably-cancel-*` headers (see {@link HEADER_CANCEL_RUN_ID} etc.).
 */
export const EVENT_ABORT = 'ai-abort';

// ---------------------------------------------------------------------------
// Domain header prefix (used by codec implementations)
// ---------------------------------------------------------------------------

/** Prefix for domain-specific headers. Distinguishes codec-layer headers from transport `x-ably-*` headers. */
export const DOMAIN_HEADER_PREFIX = 'x-domain-';
