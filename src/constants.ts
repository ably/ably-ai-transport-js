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

/** Header: message identity. Assigned per message (user or assistant). Used for optimistic reconciliation on the client. */
export const HEADER_MSG_ID = 'x-ably-msg-id';

/** Header: clientId of the user who initiated the run. Set by the server on stream messages. */
export const HEADER_RUN_CLIENT_ID = 'x-ably-run-client-id';

/** Header: message role (e.g. "user", "assistant"). */
export const HEADER_ROLE = 'x-ably-role';

/** Header: the msg-id of the existing message this Ably message amends. Present on cross-run amendment events. */
export const HEADER_AMEND = 'x-ably-amend';

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

// ---------------------------------------------------------------------------
// Fork / branching headers
// ---------------------------------------------------------------------------

/** Header: the msg-id of the immediately preceding message in this branch. */
export const HEADER_PARENT = 'x-ably-parent';

/** Header: the msg-id of the message this one replaces (creates a fork). */
export const HEADER_FORK_OF = 'x-ably-fork-of';

// ---------------------------------------------------------------------------
// Run lifecycle headers
// ---------------------------------------------------------------------------

/** Header: reason a run ended (on x-ably-run-end messages). */
export const HEADER_RUN_REASON = 'x-ably-run-reason';

// ---------------------------------------------------------------------------
// Message / event names
// ---------------------------------------------------------------------------

/** Message name: client->server cancel signal. */
export const EVENT_CANCEL = 'x-ably-cancel';

/** Message name: server publishes this to signal a run has started. */
export const EVENT_RUN_START = 'x-ably-run-start';

/** Message name: server publishes this to signal a run has ended. */
export const EVENT_RUN_END = 'x-ably-run-end';

/** Message name: transport-level abort signal (stream cancelled). */
export const EVENT_ABORT = 'x-ably-abort';

/** Message name: transport-level error signal. */
export const EVENT_ERROR = 'x-ably-error';

// ---------------------------------------------------------------------------
// Domain header prefix (used by codec implementations)
// ---------------------------------------------------------------------------

/** Prefix for domain-specific headers. Distinguishes codec-layer headers from transport `x-ably-*` headers. */
export const DOMAIN_HEADER_PREFIX = 'x-domain-';
