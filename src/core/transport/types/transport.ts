/**
 * Transport-layer types: the send-side client/agent surfaces and the
 * receive-side event stream.
 *
 * These are the transport's public boundary: publish and subscribe to codec
 * events with run/step bracketing, and fold those events into the
 * application's own state.
 */

import type * as Ably from 'ably';

import type { RunLifecycleEvent, StepLifecycleEvent } from './lifecycle.js';
import type { CancelRequest, RunEndReason, StepEndReason } from './shared.js';
import type { SteerResult } from './steer.js';

// ---------------------------------------------------------------------------
// Receive side
// ---------------------------------------------------------------------------

/**
 * The transport-tier metadata carried on one inbound wire message, surfaced to
 * a receive-stream consumer alongside the decoded events.
 *
 * The transport reads these fields off the `extras.ai.transport` header tier
 * (and the message's own Ably fields) but never interprets the structure
 * fields (`parent` / `forkOf` / `regenerates` / `inputCodecMessageId`) — those
 * are carried verbatim for a consumer reconstructing conversation structure;
 * the application interprets them. Every typed field is optional: a given wire
 * message populates only
 * the fields its message name and headers carry.
 *
 * The typed fields are a convenience projection of the two raw header buckets.
 * {@link transport} and {@link codec} carry the complete `extras.ai.transport`
 * and `extras.ai.codec` tiers verbatim, so a consumer rebuilding conversation
 * state has full fidelity and no consumer needs privileged access to the raw
 * wire.
 */
export interface WireMeta {
  /**
   * The complete `extras.ai.transport` header tier, verbatim. The transport
   * writes and reads run/step/structure headers here; a consumer folds a
   * message by reading this bucket. Empty object when the wire carried no
   * transport tier.
   */
  transport: Record<string, string>;
  /**
   * The complete `extras.ai.codec` header tier, verbatim — the codec's own
   * per-message headers (e.g. stream identity, status). Empty object when the
   * wire carried no codec tier.
   */
  codec: Record<string, string>;
  /**
   * The application's own user headers, verbatim — Ably's `extras.headers`
   * slot, outside the SDK's `extras.ai` envelope (see
   * {@link PublishInputOptions.headers}). Empty object when the wire carried
   * none.
   */
  headers: Record<string, string>;
  /** Ably channel serial of the message. Present on every wire-delivered event; `undefined` only for a locally synthesised event a consumer constructs itself. */
  serial: string | undefined;
  /** The `codec-message-id` header — the logical message this event belongs to, or `undefined` when the wire carried none. */
  codecMessageId: string | undefined;
  /** The `run-id` header — the run this message was published under, or `undefined` for a run-less user input. */
  runId: string | undefined;
  /** The `step-id` header — the step attempt that published this output, or `undefined` when the message belonged to no step. */
  stepId: string | undefined;
  /** The `step-start-serial` header — the identity of the step attempt (the serial of its `ai-step-start`), or `undefined` when the message belonged to no step. */
  stepStartSerial: string | undefined;
  /** Ably server timestamp (epoch ms) of the message, or `undefined` for a locally synthesised event. */
  timestamp: number | undefined;
  /** The `role` header (e.g. `"user"`, `"assistant"`), or `undefined` when the wire carried none. */
  role: string | undefined;
  /** The publisher's Ably `clientId`, or `undefined` for an anonymous / wildcard connection. */
  clientId: string | undefined;
  /** The Ably message name (e.g. `ai-input`, `ai-output`), or `undefined` when the platform did not echo it (appends). */
  messageName: string | undefined;
  /**
   * The append version serial (`version.serial`) — the per-delivery identity
   * an appending stream advances. A consumer deduping whole-wire replays keys
   * its high-water-mark on this; a
   * transport-only consumer can ignore it. `undefined` for a locally
   * synthesised event.
   */
  versionSerial: string | undefined;
  /** The append version timestamp (`version.timestamp`, epoch ms), or `undefined` for a locally synthesised event. */
  versionTimestamp: number | undefined;
  /** Structure header `parent` — the codec-message-id of the preceding message in this branch. Carried verbatim; the application interprets it. */
  parent: string | undefined;
  /** Structure header `fork-of` — the codec-message-id this message replaces. Carried verbatim; the application interprets it. */
  forkOf: string | undefined;
  /** Structure header `msg-regenerate` — the codec-message-id this run regenerates. Carried verbatim; the application interprets it. */
  regenerates: string | undefined;
  /** Structure header `input-codec-message-id` — the codec-message-id of the input that triggered this run. Carried verbatim; the application interprets it. */
  inputCodecMessageId: string | undefined;
  /**
   * The parsed `input-codec-message-ids` bracket receipt — on an
   * `ai-run-end` / `ai-run-suspend` event, the codec-message-ids of every
   * input the run's output considered (trigger + stamped steers).
   * `undefined` on other messages, when the run produced no output, or when
   * the header is malformed (the raw value stays on {@link transport}).
   * Resolve "was this input processed?" by id membership.
   */
  inputCodecMessageIds: string[] | undefined;
  /**
   * The parsed `steer-codec-message-ids` stamp — the steer codec-message-ids
   * the agent drained before the step attempt that produced this output, or
   * `undefined` when the wire carried no stamp (a malformed stamp degrades to
   * `undefined`; the raw value stays on {@link transport}).
   */
  steerCodecMessageIds: string[] | undefined;
}

/**
 * One classified event off the receive stream. Discriminated on `kind`:
 *
 * - `message` — a codec-decoded message: its {@link WireMeta} plus the decoded
 *   input and output events (each may be empty, but never both — an empty
 *   wire-only carrier that also has no run-id is filtered out and never
 *   surfaces).
 * - `run-lifecycle` — a parsed run start / suspend / resume / end event.
 * - `step-lifecycle` — a parsed step start / end event.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export type TransportEvent<TInput, TOutput> =
  | {
      /** Discriminator for a codec-decoded message event. */
      kind: 'message';
      /** The transport-tier metadata for the carrying wire message. */
      meta: WireMeta;
      /** The decoded client inputs from this message, in wire order. */
      inputs: TInput[];
      /** The decoded agent outputs from this message, in wire order. */
      outputs: TOutput[];
    }
  | {
      /** Discriminator for a run-lifecycle event. */
      kind: 'run-lifecycle';
      /** The parsed run-lifecycle event. */
      event: RunLifecycleEvent;
    }
  | {
      /** Discriminator for a step-lifecycle event. */
      kind: 'step-lifecycle';
      /** The parsed step-lifecycle event. */
      event: StepLifecycleEvent;
    };

/**
 * The receive side of the transport: a decoded event stream a consumer
 * subscribes to. Each inbound wire message produces at most one typed
 * {@link TransportEvent} (emitted before the raw `ably-message`), so a consumer
 * can rebuild conversation state itself — keyed by codec-message-id, grouped by
 * run, deduped by step.
 *
 * Delivery is synchronous and in registration order: each event reaches every
 * subscriber before the next event is processed, and a throwing subscriber is
 * caught and logged so it cannot starve the others.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface TransportReceiver<TInput, TOutput> {
  /**
   * Subscribe to classified transport events. Fires once per inbound wire
   * message that produces an event, before the matching `ably-message`.
   * @param event - The literal `'event'`.
   * @param handler - Called with each {@link TransportEvent} in wire order.
   * @returns An unsubscribe function.
   */
  on(event: 'event', handler: (e: TransportEvent<TInput, TOutput>) => void): () => void;
  /**
   * Subscribe to the raw inbound Ably messages, emitted AFTER the matching
   * typed `event` so a handler sees state any earlier subscriber folded.
   * @param event - The literal `'ably-message'`.
   * @param handler - Called with each raw inbound Ably message.
   * @returns An unsubscribe function.
   */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  /**
   * Subscribe to receive-stream errors: channel/subscription failures, codec
   * decode failures, and (on the client transport) channel continuity loss —
   * each an `Ably.ErrorInfo` with a distinguishing `code`. A single decode
   * failure drops that one message and emits the error rather than tearing
   * down the stream; a `SessionContinuityNotGuaranteed` error means live delivery may
   * silently have gaps until the consumer re-hydrates.
   * @param event - The literal `'error'`.
   * @param handler - Called with each error.
   * @returns An unsubscribe function.
   */
  on(event: 'error', handler: (err: Ably.ErrorInfo) => void): () => void;
}

// ---------------------------------------------------------------------------
// Send side: client
// ---------------------------------------------------------------------------

/** Per-publish options for {@link ClientTransport.publishInput}. */
export interface PublishInputOptions {
  /** The codec-message-id to publish under. Defaults to a fresh id when omitted. */
  codecMessageId?: string;
  /** Structure: the codec-message-id of the preceding message in this branch. Omit for linear chat. Carried verbatim; the application interprets it. */
  parent?: string;
  /** Structure: the codec-message-id this input replaces (an edit fork). Omit for linear chat. Carried verbatim; the application interprets it. */
  forkOf?: string;
  /** Structure: the codec-message-id this input regenerates. Omit for linear chat. Carried verbatim; the application interprets it. */
  regenerates?: string;
  /** Reuse a known run-id (a continuation of an existing run). Omit for a fresh send; the agent mints the run-id at run-start. */
  runId?: string;
  /** Arbitrary user-provided headers, published in Ably's own `extras.headers` slot (outside the SDK's `extras.ai` envelope) and surfaced back on {@link WireMeta.headers}. */
  headers?: Record<string, string>;
}

/** The identifiers assigned to a published input, returned by {@link ClientTransport.publishInput}. */
export interface PublishInputResult {
  /** The codec-message-id the input was published under — the caller's option value, or a freshly minted id. A consumer keying its own optimistic UI reconciles it against the wire delivery by this id. */
  codecMessageId: string;
  /** The per-publish `event-id` stamped on the wire — distinct from `codecMessageId`, this is what an agent's `locateInput` matches to find the input that woke an invocation. */
  eventId: string;
  /**
   * The run-id of the run this input triggers. A continuation
   * ({@link PublishInputOptions.runId} set) resolves immediately with that id
   * — the addressed run answers with `ai-run-resume`, which names no
   * triggering input. A fresh publish resolves when the transport observes
   * the first `ai-run-start` whose `input-codec-message-id` header matches
   * this publish's {@link codecMessageId} — stamped when the agent opens its
   * run with `inputCodecMessageId`, the same threading cancel routing relies
   * on. Never resolves for a fresh input that triggers no run. Rejects on
   * {@link ClientTransport.close} and on channel continuity loss; a rejection
   * handler is pre-attached, so a caller that ignores `runId` never sees an
   * unhandled rejection.
   */
  runId: Promise<string>;
}

/** Options for {@link ClientTransport.history} and {@link AgentTransport.history}. */
export interface TransportHistoryOptions {
  /**
   * Keep fetching pages until at least this many wire messages have been
   * scanned. Page granular: the call finishes the page it is on, so the batch
   * may exceed the limit. Omit to fetch one page per call — the caller's own
   * loop is then the pager, so counting calls counts pages.
   */
  limit?: number;
  /**
   * Abort signal, checked between page fetches. When it fires the call
   * rejects with `OperationCancelled`; the cursor stays resumable, so a later
   * call continues from where this one stopped.
   */
  signal?: AbortSignal;
  /**
   * Called after each page fetch completes, before the next fetch begins. A
   * durable consumer uses it as a heartbeat while a long scan pages the
   * channel; it observes progress only, and its return value is ignored.
   */
  onPage?: () => void;
}

/**
 * One batch of history events, returned by {@link ClientTransport.history}
 * and {@link AgentTransport.history}.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface TransportHistoryResult<TInput, TOutput> {
  /**
   * The classified events in this batch, in chronological (oldest-first)
   * order. Each batch is older than the one the previous call returned, so a
   * consumer prepends: `all = [...batch.events, ...all]`. History events are
   * returned here only — they are never emitted to the client's `subscribe`
   * handlers.
   */
  events: TransportEvent<TInput, TOutput>[];
  /**
   * True when the cursor reached the channel's attach point — the whole
   * history has been returned and further calls resolve with an empty batch.
   */
  exhausted: boolean;
}

/**
 * The client transport: a self-contained publish + receive surface over one
 * channel and codec. The factory
 * owns the channel subscription and the receive stream; {@link connect}
 * starts delivery, {@link subscribe} observes classified events, and
 * {@link history} pages older events on demand.
 *
 * Holds no run registry — a cancel's or steer's `runId` is sourced from
 * {@link PublishInputResult.runId} (resolved from the triggering input's
 * `ai-run-start`) or from `run-lifecycle` events off the receive stream, and
 * a consumer keys its own send state on the returned `codecMessageId`.
 * The only cross-message state is the steer ledger behind {@link steer} and
 * the pending `runId` watches behind {@link publishInput}.
 * @template TInput - The codec's input-event domain type accepted by
 *   {@link publishInput}.
 * @template TOutput - The codec's output-event domain type carried on
 *   received events.
 */
export interface ClientTransport<TInput, TOutput> extends TransportReceiver<TInput, TOutput> {
  /**
   * Subscribe the transport's listener to the channel and attach it, starting
   * live event delivery. Single-flight and idempotent: concurrent and repeat
   * calls share one attempt, and a failed attempt is retried by the next
   * call. Every other method requires a successful `connect()` first. A
   * failure is emitted on `error` and rejects this call.
   */
  connect(): Promise<void>;
  /**
   * Subscribe to classified transport events — shorthand for
   * `on('event', handler)`. Fires for live wire events; history batches do
   * not pass through here.
   * @param handler - Called with each {@link TransportEvent} in wire order.
   * @returns An unsubscribe function.
   */
  subscribe(handler: (event: TransportEvent<TInput, TOutput>) => void): () => void;
  /**
   * Publish one codec input event to the channel. Nothing is emitted locally:
   * the sender's own input reaches it back as the ordinary channel delivery
   * (like any other subscriber's), carrying the returned `codecMessageId` so
   * a consumer keying its own optimistic UI on it reconciles the delivery.
   * Requires {@link connect}.
   * @param event - The codec input event to publish.
   * @param opts - Optional per-publish overrides; see {@link PublishInputOptions}.
   * @returns The assigned `codecMessageId` and `eventId`, plus a `runId`
   *   promise resolved from the triggering input's `ai-run-start`.
   */
  publishInput(event: TInput, opts?: PublishInputOptions): Promise<PublishInputResult>;
  /**
   * Publish an `ai-cancel` envelope targeting the given run. Stateless — the
   * caller supplies a `runId` captured from a `run-lifecycle` start event. The
   * envelope carries a per-cancel `event-id` for rewind redelivery; the read
   * side ignores it, so cancels are idempotent. Requires {@link connect}.
   * @param runId - The run to cancel.
   */
  cancel(runId: string): Promise<void>;
  /**
   * Publish a steering input into an open run and observe whether the run's
   * output considered it. Returns synchronously with two promises:
   * `published` resolves with the publish acknowledgement's Ably-assigned
   * serial (no channel echo is involved), and `outcome` resolves
   * at the run's next lifecycle bracket by membership of the steer's
   * codec-message-id in the `steer-codec-message-ids` stamps observed on the
   * run's outputs — consumed on membership; not-consumed only at
   * `ai-run-end` (a suspend leaves it pending for a later resume to
   * consume). Steering a run whose `ai-run-end` this transport has already
   * received rejects both promises without publishing. Requires
   * {@link connect}; in-flight outcomes reject on {@link close} and on
   * channel continuity loss.
   * @param runId - The open run to steer: a run-id string from a
   *   `run-lifecycle` start event, or a promise of one (typically
   *   {@link PublishInputResult.runId}) — the steer publishes once it
   *   resolves, and both promises reject if it rejects.
   * @param event - The codec input event to publish as the steer.
   * @returns The `published` / `outcome` promise pair.
   */
  steer(runId: string | Promise<string>, event: TInput): SteerResult;
  /**
   * Page the channel's history backwards from the attach point and return the
   * classified events as a batch — never emitted to `subscribe` handlers.
   * Each call returns the next older slice and leaves the cursor paused, so
   * repeated calls walk toward the start of the channel. Decoding shares the
   * live stream's decoder, so a stream spanning the attach boundary is not
   * double-decoded; a single undecodable message is skipped and emitted on
   * `error`. Single-flight: concurrent calls serialise. Requires
   * {@link connect}. Rejects with `HistoryFetchFailed` when a page fetch
   * fails after retries.
   * @param opts - Optional batch bounds; see {@link TransportHistoryOptions}.
   * @returns The batch of events and whether history is exhausted.
   */
  history(opts?: TransportHistoryOptions): Promise<TransportHistoryResult<TInput, TOutput>>;
  /**
   * Unsubscribe the transport's listener from the channel and stop all
   * delivery. Terminal: every subsequent `connect`, `publishInput`, `cancel`,
   * `steer`, or `history` call rejects; in-flight steer outcomes reject; and
   * existing subscriptions simply receive nothing further. The channel itself
   * is caller-owned and is not detached.
   */
  close(): void;
}

// ---------------------------------------------------------------------------
// Send side: run write surface
// ---------------------------------------------------------------------------

/**
 * An output source accepted by {@link AgentRunTransport.pipe} and
 * {@link RunStepTransport.pipe}: a `ReadableStream` or any `AsyncIterable` of
 * codec outputs. A provider SDK stream that is async-iterable (the OpenAI
 * Responses stream, for one) pipes in directly, with no hand-written
 * `ReadableStream` wrapper. The transport pulls the source one output at a
 * time and closes it when the pipe ends, is cancelled, or errors: it releases
 * a stream reader's lock, or calls an iterator's `return()` for best-effort
 * upstream teardown.
 * @template TOutput - The codec output type carried by the source.
 */
export type PipeSource<TOutput> = ReadableStream<TOutput> | AsyncIterable<TOutput>;

/** Options for {@link AgentRunTransport.createStep}. */
export interface StepOptions {
  /**
   * A stable identifier for this step, used to coalesce retries: a fresh
   * attempt under an existing `stepId` supersedes the prior attempt's output
   * (latest channel serial wins) instead of appending it to the conversation.
   *
   * Omit it for the common case. The SDK then assigns an id scoped to the
   * current invocation, so steps from different invocations of the same run
   * (e.g. the original turn and a suspend/resume continuation) never collide;
   * and a no-`stepId` call made after this invocation's previous step ended
   * `failed` reuses that step's id, so an in-process `try`/`catch` retry
   * coalesces with no ceremony.
   *
   * Pass an explicit id when the SAME logical step re-attempts in a SEPARATE
   * process — a durable-execution retry — since that fresh process has no
   * in-memory step history to reuse. Use the framework's own stable step
   * identity: a Vercel Workflow DevKit `getStepMetadata().stepId` (stable
   * across retries) or a Temporal activity id, and supply a matching stable
   * {@link RunIdentity.runId} so the retry re-attempts the same run. **Omit it
   * on a cross-process retry and the SDK mints a fresh id, so the retry's
   * output is appended beside the failed attempt's instead of superseding it —
   * a silent double-output.**
   */
  stepId?: string;

  /**
   * The clientId to attribute this step to — the participant whose
   * most-recently-incorporated input shapes it (the innermost of the three
   * concentric client-identity scopes; stamped as `step-client-id`).
   *
   * Omit it for the common case. The SDK then resolves the step's client by
   * inheriting the prior step's value (sticky), or, for the run's first step,
   * defaulting to the triggering input's publisher (`input-client-id`). Supply
   * an explicit value when a steer incorporates a fresh input mid-run so the
   * step attributes to that input's publisher rather than inheriting the prior
   * step's client — the seam a steering signal populates. A run with no steering
   * never sets it and the sticky default suffices.
   */
  stepClientId?: string;
}

/** Parameters for {@link RunStepTransport.end}. */
export interface StepEndParams {
  /**
   * The terminal reason. Omit to derive it from the step's piped output —
   * `failed` if any {@link RunStepTransport.pipe} errored, else `complete` — so
   * the common "compute an outcome, then end" flow needs no `try`/`catch`.
   * Pass an explicit reason to override.
   */
  reason?: StepEndReason;
}

/** The result of streaming a response through the encoder. */
export interface StreamResult {
  /** Why the stream ended. */
  reason: RunEndReason;
  /**
   * The error that caused the stream to fail, present when `reason` is
   * `'error'`. This is the original error (e.g. from the LLM provider)
   * preserved so the caller can inspect provider-specific fields. The
   * run's {@link OpenRunHooks.onError} callback also fires with a wrapped
   * `Ably.ErrorInfo` (code `RunResponseStreamFailed`) for standardized observability.
   */
  error?: Error;
}

/**
 * A run's identity — which run this is, and which invocation of it is
 * publishing.
 *
 * Both fields are plain data, so an orchestration that opens a run in one
 * process can thread its identity to another that re-enters it (an
 * `openRun` naming the same `runId`); the run handle itself does not cross
 * processes. Neither field accepts the empty string; omit a field to have it
 * minted.
 */
export interface RunIdentity {
  /**
   * The run's id — the conversation turn's identity, and the durable key a
   * continuing process re-enters the run by ({@link OpenRunOptions.runId}).
   *
   * Supply a stable value under durable execution so a fresh-process retry
   * re-enters the run instead of minting a new UUID and opening a parallel
   * one. This is independent of {@link StepOptions.stepId}: a run id is the
   * turn's identity, a step id is one re-attemptable unit within the turn.
   * Both want a stable source on retry, but they are distinct ids — do not
   * treat the framework's step id as a run id across turns.
   */
  runId: string;

  /**
   * The id of the invocation publishing for the run — one per HTTP request on
   * the normal path, or one per activity of a durable turn, stamped on every
   * event that process publishes for the run. Independent of the run's owner
   * identity: a continuing activity stamps its own id, not the opener's.
   */
  invocationId: string;
}

/**
 * How a run terminates, passed to {@link AgentRunTransport.end}. Discriminated
 * on `reason`: an `'error'` end may carry a terminal `error`; any other reason
 * carries none.
 */
export type RunEndParams =
  | {
      /** Why the run ended — any terminal reason other than `'error'`. */
      reason: Exclude<RunEndReason, 'error'>;
    }
  | {
      /** The run ended in error. */
      reason: 'error';
      /**
       * Optional terminal error to surface to clients. Omit to end in error
       * without detail.
       */
      error?: Ably.ErrorInfo;
    };

// ---------------------------------------------------------------------------
// Send side: agent
// ---------------------------------------------------------------------------

/** Options for {@link AgentTransport.openRun}. */
export interface OpenRunOptions {
  /**
   * The located input that woke this invocation (the result of
   * {@link AgentTransport.locateInput}). Supplying it lets the input's own
   * wire metadata drive the open, so the caller never decides start-vs-resume:
   *
   * - The input's `meta.runId` (the run-id header a client stamps on a
   *   continuation) selects the opening event — present means the open
   *   re-enters that run with `ai-run-resume`; absent means a fresh
   *   `ai-run-start` (under {@link runId} when pinned, else a minted id).
   * - `meta.codecMessageId` defaults {@link inputCodecMessageId}, and — on a
   *   fresh open only — `meta.parent` / `meta.forkOf` / `meta.regenerates`
   *   default the structure options. An explicitly supplied option wins over
   *   the input's value.
   */
  input?: LocatedInput<unknown>;
  /**
   * Reuse a fixed run-id. Without an {@link input}, supplying it marks the
   * open as a continuation of that run. With an input, it is the fresh-run
   * pin only — a durable agent supplies a stable id so a fresh-process retry
   * re-enters the same run — and a continuation's id comes from the input.
   */
  runId?: string;
  /** Reuse a fixed invocation-id. Omit to mint a fresh one (one per HTTP request). */
  invocationId?: string;
  /** Structure: the codec-message-id of the parent message. Omit for a root run. */
  parent?: string;
  /** Structure: the codec-message-id being forked (an edit). Omit unless forking. */
  forkOf?: string;
  /** Structure: the codec-message-id this run regenerates. Omit unless regenerating. */
  regenerates?: string;
  /**
   * The triggering input's codec-message-id (thread it from
   * {@link AgentTransport.locateInput}'s `meta.codecMessageId`, or the trigger
   * payload). Supplying it lets a fresh-send cancel — one the client keyed by
   * input before it learned the run-id — route to this run, including a cancel
   * that arrived before this `openRun`; it also stamps the
   * `input-codec-message-id` anchor on the run's outputs. Without it, only
   * cancels naming the run-id route here.
   */
  inputCodecMessageId?: string;
}

/**
 * Per-run callbacks and abort signal accepted by {@link AgentTransport.openRun}
 * — how a run behaves.
 *
 * A throwing `onCancel` or `onSteer` rejects nothing: the error is delivered
 * per {@link OpenRunHooks.onError}'s routing (or the transport's `error`
 * stream) and the run continues.
 * @template TOutput - The codec's output-event domain type.
 */
export interface OpenRunHooks<TOutput> {
  /**
   * An external AbortSignal (typically the HTTP request's `req.signal`) that,
   * when fired, cancels this run. This allows platform-level cancellation —
   * request cancellation, serverless function timeout — to stop LLM generation
   * and stream piping gracefully.
   */
  signal?: AbortSignal;

  /**
   * Called before each Ably message the run's encoder publishes, after the SDK
   * stamps its own transport headers. Mutate the message in place to add custom
   * headers under extras.ai. Run and step lifecycle messages publish straight to
   * the channel, so they do not pass through this hook.
   */
  onAblyMessage?: (message: Ably.Message) => void;

  /**
   * Called when the run's stream is cancelled (by client cancel or server).
   * Receives a write function to publish final outputs before the cancellation finalises.
   */
  onCancelled?: (write: (output: TOutput) => Promise<void>) => void | Promise<void>;

  /**
   * Called when a cancel message arrives matching this run.
   * Return true to allow cancellation (fires `abortSignal`, stream cancels).
   * Return false to reject (cancel ignored, stream continues).
   * If not provided, all cancels are accepted.
   */
  onCancel?: (request: CancelRequest) => Promise<boolean>;

  /**
   * Called with non-fatal run-scoped errors that have no other delivery
   * path. Fires in three scenarios:
   * - Stream failures in `pipe` — the underlying error is also returned on
   *   {@link StreamResult.error}, but this callback delivers it wrapped as an
   *   `Ably.ErrorInfo` (code `RunResponseStreamFailed`) for standardized observability.
   * - A throw from the `onCancel` handler (code `RunCancelHandlerFailed`). The run
   *   is NOT cancelled: the SDK never reaches the abort.
   * - A throw from the `onSteer` handler (code `RunSteerHandlerFailed`). The run is
   *   unaffected — the steering message has already folded in, so only the
   *   notification failed.
   * - A failed opening publish (`openRun` returns without awaiting it). The
   *   failure also rejects every later output verb through the shared open
   *   promise, but a caller that awaits no output verb — one waiting on the
   *   opening event's channel echo, say — observes it only here.
   *
   * Publish failures in `end` are not delivered here — `end` rejects its
   * returned promise with an `Ably.ErrorInfo`, and the caller should handle
   * it at the await site. Run errors never render the transport unusable, but
   * the run may be in an inconsistent state; the caller should typically
   * `end` it with reason `'error'`.
   *
   * A failure in the `onCancel` or `onSteer` handler with no `onError` set
   * falls back to the transport's `error` stream so it is never silently
   * dropped — one delivery path or the other, never both. A `pipe` stream
   * failure with no `onError` is always still available on
   * {@link StreamResult.error}.
   */
  onError?: (error: Ably.ErrorInfo) => void;

  /**
   * Called when a steering message is tracked for this run — a client
   * published a user-input event tagged with this run's `run-id` while the
   * run was active. Fires once per inbound steering message (per-message,
   * not coalesced).
   *
   * The handler is a hint: it lets the agent race the steering arrival
   * against an in-flight model call to decide whether to cancel and
   * restart. The SDK never interrupts a model call itself. Authoritative
   * visibility of pending steering is via {@link AgentRunTransport.hasInput}.
   */
  onSteer?: () => void;
}

/** The located input that woke an invocation, returned by {@link AgentTransport.locateInput}. */
export interface LocatedInput<TInput> {
  /** The triggering input's transport-tier metadata. */
  meta: WireMeta;
  /** The decoded input events the triggering wire message carried, in wire order. */
  inputs: TInput[];
}

/**
 * The agent transport: open runs, locate the input that woke an invocation,
 * page the conversation's history for LLM context, and observe the channel —
 * cancel signals route onto the matching run handle, and a steering message
 * under an open run's run-id both surfaces as an ordinary event on the
 * receive stream (for the agent to fold itself) and flips the run handle's
 * {@link AgentRunTransport.hasInput}.
 * @template TInput - The codec's input-event domain type, located by {@link locateInput}.
 * @template TOutput - The codec's output-event domain type, published by the run/step handles.
 */
export interface AgentTransport<TInput, TOutput> extends TransportReceiver<TInput, TOutput> {
  /**
   * Subscribe the transport's listener to the channel and attach it, starting
   * live event delivery and cancel routing. Single-flight and idempotent:
   * concurrent and repeat calls share one attempt, and a failed attempt is
   * retried by the next call. Every other method requires a successful
   * `connect()` first — a run opened without it could silently miss the
   * cancel signals addressed to it. A failure is emitted on `error` and
   * rejects this call.
   */
  connect(): Promise<void>;
  /**
   * Subscribe to classified transport events — shorthand for
   * `on('event', handler)`. Fires for live wire events and for the optimistic
   * step-lifecycle seed a run's output verbs emit; history batches do not
   * pass through here.
   * @param handler - Called with each {@link TransportEvent} in wire order.
   * @returns An unsubscribe function.
   */
  subscribe(handler: (event: TransportEvent<TInput, TOutput>) => void): () => void;
  /**
   * Open a run and return a handle to publish its output and lifecycle. The
   * normal agent path passes the located input
   * (`openRun({ input: located })`): the input's run-id header decides the
   * opening event — a continuation re-enters that run with `ai-run-resume`, a
   * fresh send opens with `ai-run-start` — and the input's metadata defaults
   * the anchor and structure options (see {@link OpenRunOptions.input}).
   * Without a located input, a supplied `opts.runId` marks a continuation and
   * a fresh open publishes `ai-run-start`. The run is registered for cancel
   * routing until it ends; a cancel already buffered for
   * `opts.inputCodecMessageId` is honoured immediately. Requires
   * {@link connect}.
   * @param opts - Optional located input, run identity and structure; see {@link OpenRunOptions}.
   * @param hooks - Optional per-run callbacks and external AbortSignal; see
   *   {@link OpenRunHooks}.
   * @returns A handle to drive the run's output and lifecycle.
   */
  openRun(opts?: OpenRunOptions, hooks?: OpenRunHooks<TOutput>): AgentRunTransport<TOutput>;
  /**
   * Adopt an already-open run without publishing anything. The handle
   * registers for cancel and steer routing exactly as {@link openRun} does,
   * and nothing reaches the channel until the caller publishes output or a
   * terminal — the caller publishes only what it means to publish. This is
   * how a durable activity re-enters a run it must gate or clean up: it
   * decides from channel history whether there is anything left to do (the
   * transport holds no run state, so that gate is the caller's), then acts.
   * Requires {@link connect}.
   * @param runId - The id of the run to adopt. Must be non-empty.
   * @param hooks - Optional per-run callbacks and external AbortSignal; see
   *   {@link OpenRunHooks}.
   * @returns A handle to drive the adopted run's output and lifecycle.
   */
  adoptRun(runId: string, hooks?: OpenRunHooks<TOutput>): AgentRunTransport<TOutput>;
  /**
   * Scan channel history for the input event whose `event-id` header matches
   * `eventId`, returning its {@link WireMeta} and decoded inputs — so an
   * agent can resume durably from channel history. Runs on a
   * throwaway decoder so it never perturbs the live receive stream's dedup
   * state. Resolves `undefined` when no matching input is found in history —
   * including when `opts.limit` bounded the scan before the whole channel was
   * walked, so a bounded caller decides what a miss means for its own retry
   * semantics.
   * @param eventId - The `event-id` to match (the invocation's `inputEventId`).
   * @param opts - Optional scan bounds; see {@link TransportHistoryOptions}.
   *   `limit` caps the wire messages scanned (page granular), `signal` aborts
   *   between pages, and `onPage` fires after each page fetch.
   * @returns The located input, or `undefined` when not found.
   */
  locateInput(eventId: string, opts?: TransportHistoryOptions): Promise<LocatedInput<TInput> | undefined>;
  /**
   * Page the channel's history backwards from the attach point and return the
   * classified events as a batch — never emitted to `subscribe` handlers — so
   * the agent can assemble prior conversation context for an inference call.
   * Each call returns the next older slice and leaves the cursor paused, so
   * repeated calls walk toward the start of the channel. Decoding shares the
   * live stream's decoder, so a stream spanning the attach boundary is not
   * double-decoded ({@link locateInput}'s throwaway scans stay separate); a
   * single undecodable message is skipped and emitted on `error`.
   * Single-flight: concurrent calls serialise. Requires {@link connect}.
   * Rejects with `HistoryFetchFailed` when a page fetch fails after retries.
   * @param opts - Optional batch bounds; see {@link TransportHistoryOptions}.
   * @returns The batch of events and whether history is exhausted.
   */
  history(opts?: TransportHistoryOptions): Promise<TransportHistoryResult<TInput, TOutput>>;
  /**
   * Unsubscribe the transport's listener from the channel and stop all
   * delivery and cancel routing. Terminal: every subsequent call rejects.
   * Open runs are not aborted or ended — their write handles simply stop
   * receiving signals. The channel itself is caller-owned and is not
   * detached.
   */
  close(): void;
}

/**
 * A handle to an open run's write surface. Publishes output (directly or via a
 * step) and drives the run's lifecycle.
 * @template TOutput - The codec's output-event domain type carried by the run's streams.
 */
export interface AgentRunTransport<TOutput> {
  /** This run's id — minted at `openRun`, or the reused continuation id. */
  readonly runId: string;
  /**
   * Fires when a cancel signal routes to this run and is accepted (see
   * {@link OpenRunHooks.onCancel}), or when the external
   * {@link OpenRunHooks.signal} aborts. In-flight pipes end `'cancelled'`
   * automatically; the agent observes this signal to abort its own work (the
   * LLM call) and then publishes the terminal itself via {@link end} with
   * reason `'cancelled'`.
   */
  readonly abortSignal: AbortSignal;
  /**
   * The agent's loop driver: whether the run has input awaiting a response
   * pass. Returns `true` until the run's first step attempt opens (the
   * initial pass answers the triggering input), then `true` iff a steering
   * message has been tracked since the previous call. Reading DRAINS pending
   * steering messages into the set the next step attempt stamps as
   * `steer-codec-message-ids`, so there is no observe-only check — call it
   * once per loop iteration, immediately before assembling the pass's
   * context. Returns `false` once {@link abortSignal} has fired.
   */
  hasInput(): boolean;
  /**
   * Pipe an output stream through the encoder to the channel, bracketed in one
   * implicit step. Returns when the stream completes, is cancelled, or errors.
   * @param source - The output source to pipe: a `ReadableStream` or any
   *   `AsyncIterable` of outputs (see {@link PipeSource}).
   * @returns The {@link StreamResult} for this pipe.
   */
  pipe(source: PipeSource<TOutput>): Promise<StreamResult>;
  /**
   * Create a step — a re-attemptable unit of agent work within this run whose
   * retries supersede the prior attempt's output. Creating the handle is
   * synchronous; {@link RunStepTransport} drives its lifecycle.
   * @param opts - Optional step identity; see {@link StepOptions}.
   * @returns A handle to drive the step.
   */
  createStep(opts?: StepOptions): RunStepTransport<TOutput>;
  /**
   * Publish `ai-run-suspend`, pausing the run without ending it. The handle
   * blocks output while suspended; {@link resume} re-opens it, {@link end} may
   * still end it, and a later invocation can also continue it under the same
   * run-id via a fresh `openRun`. Throws while a step is active — end the step
   * first. No-op once suspended or ended. When the run has produced output,
   * the suspend carries the `input-codec-message-ids` receipt — the
   * codec-message-ids of every input considered so far (trigger + stamped
   * steers).
   */
  suspend(): Promise<void>;
  /**
   * Publish `ai-run-resume`, re-entering the run. A pure re-entry signal — it
   * carries no structure headers. Re-opens a suspended handle's publish
   * surface once the publish succeeds. Throws once the run has ended.
   */
  resume(): Promise<void>;
  /**
   * Publish `ai-run-end`, ending the run. Terminal. Auto-closes a still-open
   * step first so observers are never stranded. When the run has produced
   * output, the end carries the `input-codec-message-ids` receipt — the
   * codec-message-ids of every input the run considered (trigger + stamped
   * steers, accumulated across suspend/resume). A client resolves whether a
   * steering message was processed by id membership in this receipt.
   * @param params - How the run ended; see {@link RunEndParams}.
   */
  end(params: RunEndParams): Promise<void>;
}

/**
 * A handle to one step attempt's write surface within a run. Output published
 * through it is stamped with the step's `step-id` and attempt `step-start-serial`,
 * so a retry supersedes the prior attempt's output.
 * @template TOutput - The codec's output-event domain type carried by the step's streams.
 */
export interface RunStepTransport<TOutput> {
  /** This step's id — stable across retry attempts of the same step. */
  readonly stepId: string;
  /**
   * Pipe an output stream through the encoder, stamping every output with this
   * step's identity. Returns when the stream completes, is cancelled, or
   * errors.
   * @param source - The output source to pipe: a `ReadableStream` or any
   *   `AsyncIterable` of outputs (see {@link PipeSource}).
   * @returns The {@link StreamResult} for this pipe.
   */
  pipe(source: PipeSource<TOutput>): Promise<StreamResult>;
  /**
   * Publish a single discrete output as one assistant message, stamped with
   * this step's identity. The step must be active.
   * @param event - The single codec output to publish.
   */
  send(event: TOutput): Promise<void>;
  /**
   * Publish `ai-step-end`, closing the step. Idempotent.
   * @param params - Optional {@link StepEndParams}; the reason is derived from
   *   piped output when omitted.
   */
  end(params: StepEndParams): Promise<void>;
}
