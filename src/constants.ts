/**
 * Shared constants used by both codec and transport layers.
 *
 * Header constants define the transport wire header names. Message and event
 * name constants define the run and step lifecycle signals on the channel.
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

/** Header: run correlation ID. Set on every agent-published message and on continuation client inputs, but omitted from the originating fresh client input (the agent mints the run-id at run-start). */
export const HEADER_RUN_ID = 'run-id';

/** Header: invocation correlation ID; identifies a specific invocation under a run. Agent-minted and stamped by the agent on every event it publishes for the invocation — run lifecycle (run-start/resume/suspend/end) and assistant outputs. Never set by the client on its input. */
export const HEADER_INVOCATION_ID = 'invocation-id';

/**
 * Header: per-event identifier stamped by the client on every
 * client-published event in a send — user-message events AND amend
 * events (tool-approval responses, client tool outputs). Distinct from
 * `codec-message-id` so it survives edits/retries that reuse the same
 * codec-message-id, and so amend events that target an existing message can
 * carry their own per-send identity. The invocation body lists every
 * inputEventId the agent must observe on the channel before starting LLM
 * work — `AgentTransport.locateInput` matches on this header.
 */
export const HEADER_EVENT_ID = 'event-id';

/** Header: message identity. Assigned per message (user or assistant). Used for optimistic reconciliation on the client. */
export const HEADER_CODEC_MESSAGE_ID = 'codec-message-id';

/** Header: clientId of the user who initiated the run. Stamped by the client on its user input and re-stamped by the agent on the run's lifecycle and stream messages. */
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
// Run lifecycle headers
// ---------------------------------------------------------------------------

/** Header: reason a run ended (on ai-run-end messages). */
export const HEADER_RUN_REASON = 'run-reason';

// ---------------------------------------------------------------------------
// Step lifecycle headers
// ---------------------------------------------------------------------------

/**
 * Header: step correlation ID. Identifies one step — a re-attemptable unit of
 * agent execution — within a run. Stable across retry attempts of the same
 * step: a retry reuses the `step-id` and opens a fresh `ai-step-start` (whose
 * channel serial is the attempt's identity — its `step-start-serial`). Set on
 * `ai-step-start` / `ai-step-end` and on every agent output published within
 * the step. Carrying it on outputs (not just step events) is what lets the
 * client attribute a superseded attempt's output to its step purely from the
 * message, even when that attempt's own `ai-step-start` never arrived.
 */
export const HEADER_STEP_ID = 'step-id';

/**
 * Header: the channel serial of the step attempt's `ai-step-start` — the
 * attempt's identity. Set as a back-reference on every `ai-output` and on the
 * `ai-step-end` of that attempt (an `ai-step-start` carries no
 * `step-start-serial`: its own serial IS the value). The canonical attempt for a
 * `step-id` is the one whose `ai-step-start` has the latest channel serial;
 * output whose `step-start-serial` is not that canonical serial is superseded
 * and not materialised. Every `ai-step-start` has a distinct serial, so a
 * re-streamed step (a fresh start under the same `step-id`) always supersedes
 * the prior attempt's output cleanly.
 *
 * Distinct from the run's own `ai-run-start` serial, which orders sibling
 * reply runs.
 */
export const HEADER_STEP_START_SERIAL = 'step-start-serial';

/** Header: why a step ended (on ai-step-end messages); a {@link StepEndReason}. */
export const HEADER_STEP_REASON = 'step-reason';

/**
 * Header: clientId of the participant whose most-recently-incorporated input
 * shapes the step — the innermost of the three concentric client-identity
 * scopes (`run-client-id` ⊃ `input-client-id` ⊃ `step-client-id`). Set at
 * `ai-step-start`, **sticky** across steps that incorporate no fresh input, and
 * re-derivable from the channel (the latest preceding `ai-step-start`) so the
 * stickiness survives a fresh-process step under durable execution. Stamped on
 * `ai-step-start` / `ai-step-end` and on every agent output of the step, so an
 * output self-attributes to its step's client even when that attempt's
 * `ai-step-start` never arrived — mirroring the `step-id` / `step-start-serial`
 * invariant. The run's FIRST step (no prior step, no explicit value) defaults to
 * the triggering input's publisher (`input-client-id`); a steer later populates
 * it with the incorporated input's publisher.
 */
export const HEADER_STEP_CLIENT_ID = 'step-client-id';

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

/**
 * Header: JSON-stringified array of codec-message-ids of steers the agent's
 * loop drained from pending into "recently processed" since the previous
 * step attempt opened. Stamped on a step attempt's assistant outputs via the
 * step's default headers (alongside `step-id` / `step-start-serial`); omitted when
 * the set is empty. Each steer appears on exactly one attempt's outputs — the
 * first attempt opened after `hasInput()` observed the steer.
 *
 * Used by clients to resolve `ClientTransport.steer(...)` outcomes by
 * membership: accumulate the union across the run's observed responses, then on
 * `ai-run-suspend` / `ai-run-end` check whether the steer's own
 * codec-message-id is in the union. Order-insensitive — it does not rely on
 * channel-serial monotonicity, which is not guaranteed for cross-publisher
 * delivery.
 */
export const HEADER_STEER_CODEC_MESSAGE_IDS = 'steer-codec-message-ids';

/**
 * Header: JSON-stringified array of codec-message-ids of every input the
 * run's output considered — the triggering input plus each steer a step
 * attempt stamped as `steer-codec-message-ids`. Stamped on the run's bracket
 * events (`ai-run-end` and `ai-run-suspend`); a suspend carries the ids
 * considered so far, and a later end carries the full accumulated list.
 * Omitted when the run produced no output (nothing was considered).
 *
 * The bracket is the run's consumption receipt: it is published after every
 * output of the run, so a client (live, or replaying a history walk) resolves
 * "was this input processed?" from one event by id membership, without
 * scanning the run's outputs. Checklist semantics — the list only contains
 * ids an attempt actually took, so a skipped input is never falsely claimed.
 */
export const HEADER_INPUT_CODEC_MESSAGE_IDS = 'input-codec-message-ids';

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
 * Message name: agent publishes this to open a step — one re-attemptable unit
 * of execution within a run. Carries `step-id`; its own channel serial is the
 * attempt's identity (its `step-start-serial`), so it carries no back-reference. A
 * retry of a step publishes a fresh `ai-step-start` with the same `step-id` and
 * a new serial; the latest-serial start is the canonical attempt.
 *
 * This transport step is NOT the Vercel codec's `step-start` UIMessage part: a
 * transport step is a re-attemptable unit of execution that may contain many
 * model/tool iterations, each of which a codec may surface as its own
 * `step-start` part. The `ai-` prefix marks the wire (transport) event.
 */
export const EVENT_STEP_START = 'ai-step-start';

/**
 * Message name: agent publishes this to close a step attempt. Carries
 * `step-id`, `step-start-serial` (a back-reference to the serial of the
 * `ai-step-start` it closes), and `step-reason` ("complete" or "failed").
 */
export const EVENT_STEP_END = 'ai-step-end';

/**
 * Message name: every agent-published codec event (text, reasoning, tool calls,
 * tool outputs, lifecycle helpers, file / source parts, data-* chunks) rides
 * this single wire name. The codec event's own `type` is carried in the
 * SDK-controlled codec-level `kind` header so the decoder can dispatch.
 */
export const EVENT_AI_OUTPUT = 'ai-output';

/**
 * Message name: every client-published codec event (user-message parts,
 * tool-approval responses, regenerate signals) rides this single wire
 * name. The codec event's own kind is carried in the codec-level `kind`
 * header so the decoder can dispatch.
 */
export const EVENT_AI_INPUT = 'ai-input';
