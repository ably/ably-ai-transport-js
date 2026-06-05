/**
 * Shared constants used by both codec and transport layers.
 *
 * Header constants define the transport wire header names. Message and event
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
export const HEADER_STREAM = 'stream';

/** Header: lifecycle status of a streamed message. Only set when stream is "true". One of "streaming", "complete", or "cancelled". */
export const HEADER_STATUS = 'status';

/** Header: stream identity. Set by the encoder on every streamed message; read by the decoder to correlate streams. */
export const HEADER_STREAM_ID = 'stream-id';

/** Header: marks a message as a discrete message part (from writeMessages). Set by publishDiscreteBatch; not set on lifecycle events from publishDiscrete. */
export const HEADER_DISCRETE = 'discrete';

// ---------------------------------------------------------------------------
// Identity headers (used by transport for run correlation)
// ---------------------------------------------------------------------------

/** Header: run correlation ID. Set on every message in a run. */
export const HEADER_RUN_ID = 'run-id';

/** Header: invocation correlation ID. Set on the client-published user message; identifies a specific invocation under a run. */
export const HEADER_INVOCATION_ID = 'invocation-id';

/**
 * Header: per-event identifier stamped by the client on every
 * client-published event in a send — user-message events AND amend
 * events (tool-approval responses, client tool outputs). Distinct from
 * `codec-message-id` so it survives edits/retries that reuse the same
 * codec-message-id, and so amend events that target an existing message can
 * carry their own per-send identity. The invocation body lists every
 * inputEventId the agent must observe on the channel before starting LLM
 * work — see `Run.start()`'s input-event lookup.
 */
export const HEADER_EVENT_ID = 'event-id';

/** Header: message identity. Assigned per message (user or assistant). Used for optimistic reconciliation on the client. */
export const HEADER_CODEC_MESSAGE_ID = 'codec-message-id';

/** Header: clientId of the user who initiated the run. Set by the server on stream messages. */
export const HEADER_RUN_CLIENT_ID = 'run-client-id';

/**
 * Header: clientId of the input event (the `ai-input`) that drove the
 * current invocation. The agent reads the publisher's Ably-level `clientId`
 * from the triggering input event on the channel and re-stamps it as
 * `input-client-id` on every event it publishes for that invocation
 * (run lifecycle and assistant outputs). May differ from
 * `run-client-id` on continuation invocations driven by an input
 * from a non-owner (e.g. a tool-result publish from a different client).
 * Not stamped on `ai-input` events themselves — the wire publisher's
 * Ably `clientId` already conveys that.
 */
export const HEADER_INPUT_CLIENT_ID = 'input-client-id';

/** Header: message role (e.g. "user", "assistant"). */
export const HEADER_ROLE = 'role';

// ---------------------------------------------------------------------------
// Fork / branching headers
// ---------------------------------------------------------------------------

/** Header: the codec-message-id of the immediately preceding message in this branch. */
export const HEADER_PARENT = 'parent';

/** Header: the codec-message-id of the message this one replaces (creates a fork). */
export const HEADER_FORK_OF = 'fork-of';

/**
 * Header: the msg-id of the assistant message this run regenerates.
 *
 * Stamped on the regenerate wire (and echoed on `run-start`) when the
 * client requested a regeneration. A regenerate run parents at the SAME input
 * node as the reply it regenerates, so it joins that input's reply runs as a
 * same-parent sibling (no fork-of). The View consults this header to resolve
 * the message-level sibling group and to drop the regenerated message from
 * earlier Runs in the visible chain (Spec: AIT-CT13d).
 */
export const HEADER_MSG_REGENERATE = 'msg-regenerate';

// ---------------------------------------------------------------------------
// Run lifecycle headers
// ---------------------------------------------------------------------------

/** Header: reason a run ended (on ai-run-end messages). */
export const HEADER_RUN_REASON = 'run-reason';

/**
 * Header: the `codec-message-id` of the input event that triggered the run.
 * The triggering input is the one whose `event-id` matches the invocation's
 * `inputEventId` (the last input of the originating send). The agent
 * re-stamps it on every event it publishes for the invocation (run
 * lifecycle + assistant outputs), mirroring `input-client-id`. This is the
 * codec-message-id the client owns at send time, so it lets the client
 * correlate any of those events back to the originating input without
 * depending on a client-minted run-id or invocation-id.
 */
export const HEADER_INPUT_CODEC_MESSAGE_ID = 'input-codec-message-id';

// ---------------------------------------------------------------------------
// Run-end error headers (set on `ai-run-end` when `run-reason: error`)
// ---------------------------------------------------------------------------

/** Header: numeric error code accompanying an `ai-run-end` with reason `error`. */
export const HEADER_ERROR_CODE = 'error-code';

/** Header: human-readable error message accompanying an `ai-run-end` with reason `error`. */
export const HEADER_ERROR_MESSAGE = 'error-message';

// ---------------------------------------------------------------------------
// Message / event names
// ---------------------------------------------------------------------------

/**
 * Message name: client->agent cancel intent. Targets a run by `run-id` (a
 * continuation, whose run-id the client already knows) and/or by
 * `input-codec-message-id` (a fresh send, whose run-id the agent mints at
 * run-start — so the client can only key the cancel by the triggering input's
 * codec-message-id it owns at send time). The agent resolves whichever is
 * present to the registered run; a cancel that arrives before the run is known
 * (the input-event lookup hasn't resolved the input id to a run yet) is
 * buffered by `input-codec-message-id` and honoured when the run resolves it.
 * Also carries an `event-id` so channel rewind redelivers it to a per-request /
 * serverless agent that attaches after the cancel was published.
 */
export const EVENT_CANCEL = 'ai-cancel';

/** Message name: server publishes this to signal a run has started. */
export const EVENT_RUN_START = 'ai-run-start';

/**
 * Message name: server publishes this to signal a run has suspended — paused
 * awaiting participant input (e.g. a client tool result or approval) without
 * ending. The run stays live and may be resumed under the same `runId`.
 * Distinct from `ai-run-end`, which is terminal.
 */
export const EVENT_RUN_SUSPEND = 'ai-run-suspend';

/**
 * Message name: server publishes this when a subsequent invocation re-enters an
 * already-started run (e.g. a tool-result follow-up under the same `runId`).
 * A pure re-entry signal: unlike `ai-run-start` it carries no `parent` / `fork-of`
 * (the original `ai-run-start` already established the run's structure).
 */
export const EVENT_RUN_RESUME = 'ai-run-resume';

/** Message name: server publishes this to signal a run has ended. */
export const EVENT_RUN_END = 'ai-run-end';

/**
 * Message name: every agent-published codec event (text, reasoning, tool calls,
 * tool outputs, lifecycle helpers, file / source parts, data-* chunks) rides
 * this single wire name. The codec event's own `type` is carried in the
 * `codec-type` domain header so the decoder can dispatch.
 */
export const EVENT_AI_OUTPUT = 'ai-output';

/**
 * Message name: every client-published codec event (user-message parts,
 * tool-approval responses, regenerate signals) rides this single wire
 * name. The codec event's own `type` is carried in the `codec-type`
 * domain header so the decoder can dispatch.
 */
export const EVENT_AI_INPUT = 'ai-input';
