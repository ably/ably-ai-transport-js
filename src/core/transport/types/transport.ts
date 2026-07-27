/**
 * Transport-layer types: the send-side client/agent surfaces and the
 * receive-side event stream.
 *
 * These are the public boundary that lets a developer adopt the transport on
 * its own — publish and subscribe to codec events with run/step bracketing —
 * and fold those events into their own application state, without taking the
 * Tree, View, or React layers. The Tree becomes one subscriber over the same
 * event stream rather than a hardcoded target.
 */

import type * as Ably from 'ably';

import type { CodecInputEvent, CodecOutputEvent } from '../../codec/types.js';
import type { PipeSource, RunEndParams, RunHooks, StepEndParams, StepOptions, StreamResult } from './agent.js';
import type { RunLifecycleEvent, StepLifecycleEvent } from './tree.js';

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
 * are carried verbatim for a consumer (such as the Tree) that reconstructs
 * branching. Every typed field is optional: a given wire message populates only
 * the fields its message name and headers carry.
 *
 * The typed fields are a convenience projection of the two raw header buckets.
 * {@link transport} and {@link codec} carry the complete `extras.ai.transport`
 * and `extras.ai.codec` tiers verbatim, so a consumer rebuilding conversation
 * state has full fidelity and no consumer needs privileged access to the raw
 * wire — the Tree drives its `applyMessage` off {@link transport} exactly as a
 * third-party subscriber could.
 */
export interface WireMeta {
  /**
   * The complete `extras.ai.transport` header tier, verbatim. The transport
   * writes and reads run/step/structure headers here; the Tree folds a message
   * by reading this bucket. Empty object when the wire carried no transport
   * tier.
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
  /** Ably channel serial of the message, or `undefined` for an optimistic local echo (no serial assigned yet). */
  serial: string | undefined;
  /** The `codec-message-id` header — the logical message this event belongs to, or `undefined` when the wire carried none. */
  codecMessageId: string | undefined;
  /** The `run-id` header — the run this message was published under, or `undefined` for a run-less user input. */
  runId: string | undefined;
  /** The `step-id` header — the step attempt that published this output, or `undefined` when the message belonged to no step. */
  stepId: string | undefined;
  /** The `step-start-serial` header — the identity of the step attempt (the serial of its `ai-step-start`), or `undefined` when the message belonged to no step. */
  stepStartSerial: string | undefined;
  /** Ably server timestamp (epoch ms) of the message, or `undefined` for an optimistic local echo. */
  timestamp: number | undefined;
  /** The `role` header (e.g. `"user"`, `"assistant"`), or `undefined` when the wire carried none. */
  role: string | undefined;
  /** The publisher's Ably `clientId`, or `undefined` for an anonymous / wildcard connection. */
  clientId: string | undefined;
  /** The Ably message name (e.g. `ai-input`, `ai-output`), or `undefined` for an optimistic local echo. */
  messageName: string | undefined;
  /**
   * The append version serial (`version.serial`) — the per-delivery identity
   * an appending stream advances. A consumer rebuilding the Tree's whole-wire
   * replay dedup keys its `decodedThrough` high-water-mark on this; a
   * transport-only consumer can ignore it. `undefined` for an optimistic local
   * echo.
   */
  versionSerial: string | undefined;
  /** The append version timestamp (`version.timestamp`, epoch ms), or `undefined` for an optimistic local echo. */
  versionTimestamp: number | undefined;
  /** Structure header `parent` — the codec-message-id of the preceding message in this branch. Carried verbatim; only the Tree interprets it. */
  parent: string | undefined;
  /** Structure header `fork-of` — the codec-message-id this message replaces. Carried verbatim; only the Tree interprets it. */
  forkOf: string | undefined;
  /** Structure header `msg-regenerate` — the codec-message-id this run regenerates. Carried verbatim; only the Tree interprets it. */
  regenerates: string | undefined;
  /** Structure header `input-codec-message-id` — the codec-message-id of the input that triggered this run. Carried verbatim; only the Tree interprets it. */
  inputCodecMessageId: string | undefined;
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
export type TransportEvent<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent> =
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
 * run, deduped by step — without the Tree.
 *
 * Delivery is synchronous and in registration order: each event reaches every
 * subscriber before the next event is processed, and a throwing subscriber is
 * caught and logged so it cannot starve the others.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface TransportReceiver<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent> {
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
   * Subscribe to receive-stream errors: channel/subscription failures and codec
   * decode failures, each an `Ably.ErrorInfo` with a distinguishing `code`. A
   * single decode failure drops that one message and emits the error rather
   * than tearing down the stream.
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
  /** Structure: the codec-message-id of the preceding message in this branch. Omit for linear chat. Carried verbatim; only the Tree interprets it. */
  parent?: string;
  /** Structure: the codec-message-id this input replaces (an edit fork). Omit for linear chat. Carried verbatim; only the Tree interprets it. */
  forkOf?: string;
  /** Structure: the codec-message-id this input regenerates. Omit for linear chat. Carried verbatim; only the Tree interprets it. */
  regenerates?: string;
  /** Reuse a known run-id (a continuation of an existing run). Omit for a fresh send; the agent mints the run-id at run-start. */
  runId?: string;
  /** Arbitrary user-provided headers, published in Ably's own `extras.headers` slot (outside the SDK's `extras.ai` envelope) and surfaced back on {@link WireMeta.headers} — on the wire echo and the optimistic local echo alike. */
  headers?: Record<string, string>;
}

/** The identifiers assigned to a published input, returned by {@link ClientTransport.publishInput}. */
export interface PublishInputResult {
  /** The codec-message-id the input was published under — the caller's option value, or a freshly minted id. Keys optimistic-echo reconciliation. */
  codecMessageId: string;
  /** The per-publish `event-id` stamped on the wire — distinct from `codecMessageId`, this is what an agent's `locateInput` matches to find the input that woke an invocation. */
  eventId: string;
}

/** Options for {@link ClientTransport.history} and {@link AgentTransport.history}. */
export interface TransportHistoryOptions {
  /**
   * Stop paging once at least this many events have been collected. Page
   * granular: the call finishes the page it is on, so the batch may exceed the
   * limit. Omit to page all the way to channel exhaustion.
   */
  limit?: number;
  /**
   * Abort signal, checked between page fetches. When it fires the call
   * rejects with `OperationCancelled`; the cursor stays resumable, so a later
   * call continues from where this one stopped.
   */
  signal?: AbortSignal;
}

/**
 * One batch of history events, returned by {@link ClientTransport.history}
 * and {@link AgentTransport.history}.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface TransportHistoryResult<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent> {
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
 * channel and codec, without the Tree, View, or React layers. The factory
 * owns the channel subscription and the receive stream; {@link connect}
 * starts delivery, {@link subscribe} observes classified events, and
 * {@link history} pages older events on demand.
 *
 * Holds no run registry and no cross-message reconciliation state — a
 * cancel's `runId` is sourced by the consumer from `run-lifecycle` events off
 * the receive stream, and an optimistic echo is reconciled against its wire
 * echo by `codecMessageId`.
 * @template TInput - The codec's input-event domain type accepted by
 *   {@link publishInput}.
 * @template TOutput - The codec's output-event domain type carried on
 *   received events.
 */
export interface ClientTransport<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
> extends TransportReceiver<TInput, TOutput> {
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
   * `on('event', handler)`. Fires for live wire events and for the optimistic
   * local echo a {@link publishInput} emits; history batches do not pass
   * through here.
   * @param handler - Called with each {@link TransportEvent} in wire order.
   * @returns An unsubscribe function.
   */
  subscribe(handler: (event: TransportEvent<TInput, TOutput>) => void): () => void;
  /**
   * Publish one codec input event to the channel. Emits a local `message`
   * event to `subscribe` handlers immediately (with `serial` and
   * `versionSerial` `undefined`) so the sender sees its own input before the
   * wire round-trips; the real echo later carries the same `codecMessageId`
   * so a consumer keying on it reconciles the two. Requires {@link connect}.
   * @param event - The codec input event to publish.
   * @param opts - Optional per-publish overrides; see {@link PublishInputOptions}.
   * @returns The assigned `codecMessageId` and `eventId`.
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
   * or `history` call rejects; existing subscriptions simply receive nothing
   * further. The channel itself is caller-owned and is not detached.
   */
  close(): void;
}

// ---------------------------------------------------------------------------
// Send side: agent
// ---------------------------------------------------------------------------

/** Options for {@link AgentTransport.openRun}. */
export interface OpenRunOptions {
  /** Reuse a fixed run-id. Omit to mint a fresh one (the normal path); a continuation supplies the run it re-enters. */
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
 * The per-run hooks {@link AgentTransport.openRun} accepts — the subset of the
 * session's {@link RunHooks} that applies on the standalone surface. `onError`
 * is excluded: a pipe failure returns on {@link StreamResult.error} and a
 * cancel-hook failure surfaces on the transport's `error` stream. `onSteer` is
 * excluded: steering messages surface as ordinary events on the receive
 * stream for the agent to fold itself.
 *
 * On this surface a throwing `onCancel` rejects nothing: the error is emitted
 * on the transport's `error` stream and the cancel is dropped.
 * @template TOutput - The codec's output-event domain type.
 */
export type OpenRunHooks<TOutput extends CodecOutputEvent> = Pick<
  RunHooks<TOutput>,
  'signal' | 'onAblyMessage' | 'onCancelled' | 'onCancel'
>;

/** The located input that woke an invocation, returned by {@link AgentTransport.locateInput}. */
export interface LocatedInput<TInput extends CodecInputEvent> {
  /** The triggering input's transport-tier metadata. */
  meta: WireMeta;
  /** The decoded input events the triggering wire message carried, in wire order. */
  inputs: TInput[];
}

/**
 * The agent transport: open runs, locate the input that woke an invocation,
 * page the conversation's history for LLM context, and observe the channel —
 * cancel signals route onto the matching run handle; everything else the
 * client publishes (including a steering message under an open run's run-id)
 * surfaces as ordinary events on the receive stream for the agent to fold
 * itself. Exposes no Tree-read accessors (`view`, `messages`, `status`).
 * @template TInput - The codec's input-event domain type, located by {@link locateInput}.
 * @template TOutput - The codec's output-event domain type, published by the run/step handles.
 */
export interface AgentTransport<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
> extends TransportReceiver<TInput, TOutput> {
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
   * Open a run and return a handle to publish its output and lifecycle. A fresh
   * open publishes `ai-run-start`; a continuation (an `opts.runId` naming an
   * existing run) publishes `ai-run-resume`. The run is registered for cancel
   * routing until it ends; a cancel already buffered for
   * `opts.inputCodecMessageId` is honoured immediately. Requires
   * {@link connect}.
   * @param opts - Optional run identity and structure; see {@link OpenRunOptions}.
   * @param hooks - Optional per-run callbacks and external AbortSignal; see
   *   {@link OpenRunHooks}.
   * @returns A handle to drive the run's output and lifecycle.
   */
  openRun(opts?: OpenRunOptions, hooks?: OpenRunHooks<TOutput>): AgentRunTransport<TOutput>;
  /**
   * Scan channel history for the input event whose `event-id` header matches
   * `eventId`, returning its {@link WireMeta} and decoded inputs — so a
   * transport-only agent can resume durably without the Tree. Runs on a
   * throwaway decoder so it never perturbs the live receive stream's dedup
   * state. Resolves `undefined` when no matching input is found in history.
   * @param eventId - The `event-id` to match (the invocation's `inputEventId`).
   * @returns The located input, or `undefined` when not found.
   */
  locateInput(eventId: string): Promise<LocatedInput<TInput> | undefined>;
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
export interface AgentRunTransport<TOutput extends CodecOutputEvent> {
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
   * first. No-op once suspended or ended.
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
   * step first so observers are never stranded.
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
export interface RunStepTransport<TOutput extends CodecOutputEvent> {
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
