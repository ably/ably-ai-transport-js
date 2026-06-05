/** Client session types: options, send options, the ActiveRun handle, and the ClientSession contract. */

import type * as Ably from 'ably';

import type { Logger } from '../../../logger.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../../codec/types.js';
import type { Invocation } from '../invocation.js';
import type { Tree } from './tree.js';
import type { View } from './view.js';

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
   * The client's identity, used as the Ably publisher `clientId` on
   * everything this session publishes. Surfaces on the wire as the
   * run/input client id so other clients can attribute messages.
   */
  clientId?: string;

  /** Initial messages to seed the conversation tree with. Forms a linear chain. */
  messages?: TMessage[];

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
  /**
   * Override the `inputEventId` for this send. Useful for deterministic
   * identification (tests). Defaults to `crypto.randomUUID()`.
   */
  inputEventId?: string;
}

// ---------------------------------------------------------------------------
// Active run handle
// ---------------------------------------------------------------------------

/**
 * A handle to an active client-side run, returned by `sendMessage()`,
 * `sendInput()`, `regenerate()`, and `edit()`.
 *
 * The core no longer exposes a per-run output stream — streaming is a
 * consumer-layer concern (e.g. the Vercel ChatTransport builds a stream from
 * the Tree's `output` events). The handle carries only run identity and
 * control, so it is not parameterized by the codec output type.
 */
export interface ActiveRun {
  /**
   * The synchronous routing handle for this send: the triggering input's
   * codec-message-id, which the client owns the moment it publishes and the
   * agent echoes back as `input-codec-message-id`. Stream routing and cancel
   * key on this — it is known immediately, unlike {@link runId}, which the
   * agent now mints.
   */
  inputCodecMessageId: string;
  /**
   * The run's unique identifier, resolved when the agent's `ai-run-start` for
   * this send is observed on the channel. The agent mints the run-id now (the
   * client no longer does), so it is not known synchronously: `await run.runId`
   * to learn it (this also tells you the agent has picked up the run). There is
   * no built-in deadline — race it against your own timeout if you need one.
   * Rejects only if the session is closed before run-start arrives. A
   * continuation resolves immediately with the run-id the client already knows.
   */
  runId: Promise<string>;
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
   * fires it once its input-event lookup resolves the input to the run). A
   * continuation also carries its known run-id. Resolves once the cancel is
   * published; it does not wait for {@link runId}.
   */
  cancel(): Promise<void>;
  /**
   * The codec-message-ids of optimistically inserted user messages, in order.
   * Present when the send included user messages (edit); empty for
   * regeneration (no user messages to insert optimistically).
   */
  optimisticCodecMessageIds: string[];
  /**
   * Build the {@link Invocation} pointer for this run — `inputEventId`, the
   * session's channel name as `sessionName`, and `runId` only for a
   * continuation (a fresh run omits it, leaving the agent to mint it). The
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
  readonly view: View<TInput, TMessage>;

  /**
   * Subscribe to the channel and (implicitly) attach. Idempotent —
   * subsequent calls return the same promise. `sendMessage()`,
   * `sendInput()`, `regenerate()`, `edit()`, `update()`, and `cancel()`
   * throw `InvalidArgument` until `connect()` resolves.
   */
  connect(): Promise<void>;

  /**
   * Create an additional view over the same conversation tree.
   * Each view has independent branch selections and pagination state.
   * The caller is responsible for calling `close()` on the returned view
   * when it is no longer needed, or it will be closed when the session closes.
   */
  createView(): View<TInput, TMessage>;

  /** Cancel the specified run. Publishes a cancel message and closes the local stream. */
  cancel(runId: string): Promise<void>;

  /**
   * Subscribe to non-fatal session errors. These indicate something went
   * wrong but the session is still operational. Returns an unsubscribe function.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;

  /**
   * Tear down the session: unsubscribe from the channel, close active
   * streams, clear all handlers, and prevent further operations.
   *
   * Local-state-only — the server keeps streaming until its runs end on
   * their own. To stop in-progress runs, call {@link cancel} for each
   * before `close()`.
   */
  close(): Promise<void>;
}
