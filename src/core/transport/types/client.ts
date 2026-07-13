/** Client session types: options, send options, the ClientRun handle, and the ClientSession contract. */

import type * as Ably from 'ably';
// Also augments RealtimeChannel with `.object` (ably/liveobjects side-effect).
import type * as AblyObjects from 'ably/liveobjects';

import type { Logger } from '../../../logger.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../../codec/types.js';
import type { Invocation } from '../invocation.js';
import type { BaseRun } from './run.js';
import type { SteerResult } from './steer.js';
import type { Tree } from './tree.js';
import type { ClientView } from './view.js';

// Re-exported so consumers can import the steering types from the same
// public surface as `ClientRun` and `ClientSession`.
export type { SteerOutcome, SteerResult } from './steer.js';

// ---------------------------------------------------------------------------
// Client session options
// ---------------------------------------------------------------------------

/** Options for creating a client session. */
export interface ClientSessionOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /**
   * The Ably Realtime client. The caller owns its lifecycle —
   * `session.close()` does not close the client.
   *
   * The session's identity is taken from this client's `auth.clientId` (set
   * via the Ably token or `ClientOptions.clientId`) — it is read at publish
   * time and stamped on the wire as the run/input client id so other clients
   * can attribute messages. A connection without a concrete clientId
   * (anonymous, or a wildcard `*` token) publishes without one.
   */
  client: Ably.Realtime;

  /**
   * The name of the channel to subscribe to and publish cancel signals on.
   * The session owns this channel — do not also resolve it elsewhere with
   * conflicting channel options.
   */
  channelName: string;

  /** The codec to use for encoding/decoding. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;

  /**
   * Extra Ably channel modes to request on the session's channel, on top of the
   * modes AI Transport always needs. Pass `OBJECT_MODES` (or
   * `['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH']`) to use Ably LiveObjects via
   * {@link ClientSession.object}. Omit to attach with the default mode set.
   *
   * The session requests the union of these modes with the modes it always
   * needs, so passing extra modes never drops the SDK's required modes. The
   * connection's token/key capability must permit the requested operations,
   * otherwise the server grants only the permitted subset.
   */
  channelModes?: readonly Ably.ChannelMode[];

  /**
   * Wire-message limit fetched per channel-history round trip when paging older
   * conversation history (via `view.loadOlder()` and history hydration), shared
   * by every view on this session. Independent of `loadOlder`'s reveal `limit`:
   * `loadOlder` reveals from the buffered page and only triggers a fresh fetch
   * once the buffer empties, so this tunes fetch cost, not reveal granularity.
   * Defaults to 100.
   */
  historyPageSize?: number;

  /**
   * Advanced. How long (ms, on the Ably message-timestamp timeline) a
   * structurally complete run's event log is retained after its last activity
   * before the Tree may drop it. The log is what lets a late, out-of-order wire
   * refold into canonical position and a superseding step retry drop a dead
   * attempt's output; once dropped, such a wire degrades to arrival order.
   *
   * Raise it for a durable agent whose step retries back off longer than the
   * default, so a much-later rescheduled `ai-step-start` still finds the dead
   * attempt's log to supersede; lower it in tests for deterministic, fast
   * sweeps. Defaults to 120000 (2 minutes).
   */
  reorderWindowMs?: number;

  /** Logger instance for diagnostic output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/** Per-send options for branching metadata and run identity. */
export interface SendOptions {
  /**
   * The codec-message-id of the message this send replaces (fork).
   * Set for regeneration (forkOf an assistant message) or
   * edit (forkOf a user message).
   */
  forkOf?: string;
  /**
   * The codec-message-id of the message that precedes this one in the
   * conversation thread. If omitted, auto-computed from the last
   * message in the view.
   */
  parent?: string;
  /**
   * Reuse an existing `runId` (e.g. resume a suspended run). When set,
   * the send is treated as a continuation: the run's existing observer
   * state (router stream, tree run-tracking) is reused; no fresh
   * `crypto.randomUUID()` is minted. Each continuation POST is woken by the
   * agent, which mints a distinct `invocationId` per HTTP request.
   */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Client run handle
// ---------------------------------------------------------------------------

/**
 * A handle to an active client-side run, returned by `send()`,
 * `regenerate()`, and `edit()`. Extends the shared {@link BaseRun} read-model
 * (`runId`, `status`, `error`, whole-turn `messages`) with the client's
 * routing/control surface.
 *
 * The core does not expose a per-run output stream — streaming is a
 * consumer-layer concern (e.g. the Vercel ChatTransport builds a stream from
 * the Tree's `output` events). The handle carries the shared {@link BaseRun}
 * read-model plus the client's routing/control surface, including the
 * run-scoped {@link steer} write verb.
 * @template TInput - The codec's input-event domain type accepted by
 *   {@link steer}; matches the session's `TInput`.
 * @template TMessage - The codec's message domain type read from
 *   {@link BaseRun.messages}.
 */
export interface ClientRun<TInput extends CodecInputEvent, TMessage> extends BaseRun<TMessage> {
  /**
   * The synchronous routing handle for this send: the triggering input's
   * codec-message-id, which the client owns the moment it publishes and the
   * agent echoes back as `input-codec-message-id`. Stream routing and cancel
   * key on this — it is known immediately, unlike {@link BaseRun.runId}, which
   * the agent mints.
   */
  inputCodecMessageId: string;
  /**
   * Resolves when the agent's `ai-run-start` for this send (or `ai-run-resume`
   * for a continuation) is observed on the channel — the point at which
   * {@link BaseRun.runId} becomes populated. The agent mints the run-id, so it
   * is not known synchronously: `await run.started`, then read `run.runId`.
   * There is no built-in deadline — race it against your own timeout if you
   * need one. Rejects only if the session is closed before run-start arrives.
   */
  readonly started: Promise<void>;
  /**
   * The input event's unique identifier. Stamped on the primary input event
   * published to the channel and forwarded in the HTTP POST body so the
   * agent can locate the exact triggering event.
   */
  inputEventId: string;
  /**
   * Cancel this specific run. Publishes a cancel signal synchronously — keyed
   * by the triggering input's codec-message-id ({@link inputCodecMessageId}),
   * which the client owns the moment it publishes, so a cancel issued before
   * the agent mints the run-id is still honoured (the agent buffers it and
   * fires it once its input-event watcher matches the trigger to the run). A
   * continuation also carries its known run-id. Resolves once the cancel is
   * published; it does not wait for {@link started}.
   */
  cancel(): Promise<void>;
  /**
   * Publish a codec input event that targets THIS run — steering. The steer
   * carries this run's `run-id` header so the agent's Tree folds it into the
   * active run's projection. Pass the same shape `view.send(...)` accepts:
   * typically `codec.createUserMessage(...)` for a follow-up user message, but
   * any `TInput` the codec defines is permitted.
   *
   * Returns two promises (see {@link SteerResult}): `published` for the
   * channel-publish acknowledgement (with the Ably-assigned serial) and
   * `outcome` for the consumed/not-consumed determination derived from the
   * union of `steer-codec-message-ids` stamps the run's responses carry.
   *
   * The SDK awaits {@link BaseRun.runId} internally if it has not yet resolved,
   * so this call is safe to make as soon as the handle is returned by
   * {@link ClientView}'s send / regenerate / edit. If the run-id never resolves
   * (e.g. the invocation failed), both returned promises reject.
   *
   * Once the SDK has folded an `ai-run-end` for this run, the handle is dead
   * and subsequent `steer()` calls return immediately-rejected promises — no
   * channel publish is attempted. The application recovers by issuing a new
   * `view.send(...)` + invocation.
   * @param input - The codec input event to publish, in the codec's input shape.
   * @returns Two promises: `published` (publish acknowledgement) and `outcome`
   *   (consumed/not-consumed at the next terminal event).
   */
  steer(input: TInput): SteerResult;
  /**
   * Build the {@link Invocation} pointer for this run — only `inputEventId` and
   * the session's channel name as `sessionName`. The body carries no run-id: a
   * fresh run's run-id is minted by the agent, and a continuation's run-id is
   * read off the triggering input event's wire headers, so run identity always
   * lives on the channel rather than the invocation body. The
   * application POSTs `run.toInvocation().toJSON()` to its agent endpoint to
   * wake the agent; the agent rebuilds it via {@link Invocation.fromJSON} and
   * mints the `invocationId` (and a fresh `runId`) itself. The conversation
   * itself is read from the channel, so the pointer carries only identifiers.
   */
  toInvocation(): Invocation;
}

// ---------------------------------------------------------------------------
// Client session interface
// ---------------------------------------------------------------------------

/** Client-side session that manages conversation state over an Ably channel. */
export interface ClientSession<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The complete conversation tree — all known Run nodes, events for any change. */
  readonly tree: Tree<TOutput, TProjection>;

  /** The default paginated, branch-aware view for rendering — events scoped to visible messages. */
  readonly view: ClientView<TInput, TMessage>;

  /**
   * The Ably presence object for this session's channel.
   *
   * Exposed as a convenience so callers can track and publish presence
   * (`enter`/`leave`/`update`/`get`/`subscribe`) — for example, to detect
   * whether an agent is online — without obtaining the channel separately.
   * This is the same `Ably.RealtimePresence` instance the underlying channel
   * exposes; the session applies no additional semantics. Presence operations
   * implicitly attach the channel and do not require {@link connect} to have
   * been called first.
   */
  readonly presence: Ably.RealtimePresence;

  /**
   * The Ably LiveObjects entry point for this session's channel.
   *
   * Exposed as a convenience so callers can read and mutate shared objects
   * (LiveMap / LiveCounter) on the same channel the session uses, without
   * obtaining the channel separately. This is the same `RealtimeObject`
   * instance the underlying channel exposes; the session applies no additional
   * semantics. Operating on it requires (a) the Realtime client to have been
   * constructed with the `LiveObjects` plugin from `ably/liveobjects` and
   * (b) the object channel modes to have been requested via
   * {@link ClientSessionOptions.channelModes}. When either is absent the
   * underlying SDK throws; the session does not suppress the error.
   */
  readonly object: AblyObjects.RealtimeObject;

  /**
   * Subscribe to the channel and (implicitly) attach. Idempotent —
   * subsequent calls return the same promise. The View's write operations
   * (`send()`, `regenerate()`, `edit()`) and this session's `cancel()` throw
   * `InvalidArgument` until `connect()` resolves.
   */
  connect(): Promise<void>;

  /**
   * Create an additional view over the same conversation tree.
   * Each view has independent branch selections and pagination state.
   * The caller is responsible for calling `close()` on the returned view
   * when it is no longer needed, or it will be closed when the session closes.
   */
  createView(): ClientView<TInput, TMessage>;

  /** Cancel the specified run by publishing an `ai-cancel` signal on the channel. The core does not own a per-run stream; closing any consumer-built stream is the responsibility of the layer that built it (e.g. the Vercel ChatTransport). */
  cancel(runId: string): Promise<void>;

  /**
   * Subscribe to non-fatal session errors. These indicate something went
   * wrong but the session is still operational. Returns an unsubscribe function.
   * Once the session is CLOSED this is a no-op: the handler is not registered and
   * the returned function does nothing.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;

  /**
   * Tear down the session: unsubscribe from the channel, close active views,
   * clear all handlers, and detach the channel this session attached.
   *
   * Detaching stops the session from receiving further channel messages;
   * the server keeps streaming until its runs end on their own. To stop
   * in-progress runs, call {@link cancel} for each before `close()`. The
   * detach is best-effort: a failure is swallowed and does not reject.
   */
  close(): Promise<void>;
}
