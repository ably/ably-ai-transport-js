import type * as Ably from 'ably';

/**
 * SDK-owned header names attached to messages published through the SDK.
 * Receivers read these to attribute and route messages without inspecting
 * the codec's payload.
 *
 * Headers grow phase-by-phase as the wire formats that need them land.
 * Later phases will add `x-ably-step-id`, parent/fork pointers, and
 * control-signal headers.
 */
export const Headers = {
  /** Unique message ID — appears on every chunk of a streaming message. */
  MessageId: 'x-ably-msg-id',
  /** Protocol-level role — `'user'` or `'assistant'`. */
  Role: 'x-ably-role',
  /**
   * Optional override of the publishing connection's clientId, used when a
   * backend publishes on behalf of an end-user. Set on content messages and
   * on `x-ably-run-start` to attribute a run's initiator.
   */
  ClientId: 'x-ably-client-id',
  /**
   * The run a message belongs to. Set on content messages and on every
   * run-lifecycle wire message ({@link WireMessages.RunStart},
   * {@link WireMessages.RunEnd}); later phases also carry it on
   * step-lifecycle and control-signal messages.
   */
  RunId: 'x-ably-run-id',
  /**
   * Lifecycle status carried by streamed messages and lifecycle wire
   * messages. Streamed creates set `'streaming'`; their closing append sets
   * `'finished'` or `'aborted'`. Run-end (and later step-end) wires set the
   * terminal status of the lifecycle they close.
   */
  Status: 'x-ably-status',
  /**
   * Streaming flag — `'true'` on streamed `message.create` wires (and their
   * `message.append` deltas), `'false'` on discrete creates. The decoder
   * branches on this to decide whether to open a tracker keyed by serial
   * or to route the wire through `decodeDiscrete`.
   */
  Stream: 'x-ably-stream',
  /**
   * Stream identity — set by the encoder on every streamed wire so the
   * decoder can correlate creates and appends with the codec's own
   * `chunk.id` (for text streams, tool-input streams, etc.).
   */
  StreamId: 'x-ably-stream-id',
  /**
   * Marker stamped on every wire emitted by
   * {@link import('./core/codec/index.js').EncoderCore.publishBatch} —
   * complete-message parts published from `encodeMessage`. The decoder uses
   * the marker to distinguish complete-message parts from lifecycle chunks
   * of the same name (e.g. `text` discrete-vs-streaming).
   */
  Discrete: 'x-ably-discrete',
} as const;

/** Union of valid SDK header names. */
export type HeaderName = (typeof Headers)[keyof typeof Headers];

/**
 * SDK-owned wire message names. The SDK uses these as `Ably.Message.name` for
 * lifecycle and control wire messages it produces and consumes itself; codecs
 * own the names of their content messages and the SDK never inspects them.
 *
 * The decode loop branches on `message.name` against these constants before
 * delegating to the codec, so codec implementations don't need to guard
 * against seeing lifecycle messages.
 */
export const WireMessages = {
  /** Opens a run. Carries {@link Headers.RunId} and optional {@link Headers.ClientId}. */
  RunStart: 'x-ably-run-start',
  /** Closes a run terminally. Carries {@link Headers.RunId} and {@link Headers.Status}. */
  RunEnd: 'x-ably-run-end',
} as const;

/** Union of SDK-owned wire message names. */
export type WireMessageName = (typeof WireMessages)[keyof typeof WireMessages];

/**
 * Read one of the SDK's `x-ably-*` string headers from an inbound message.
 * Returns `undefined` if `extras.headers` is absent or the value is missing
 * or not a string.
 *
 * Headers travel inside `extras.headers`; the Ably SDK types `extras` as
 * `any`, so this helper centralises the runtime narrowing instead of
 * spreading casts across callers.
 * @param message The inbound message to read from.
 * @param name The header name to read.
 * @returns The string header value, or `undefined` if not present.
 */
export const readHeader = (message: Ably.InboundMessage, name: HeaderName): string | undefined => {
  // CAST: Ably types `extras` as `any` (see Ably.Message). Narrow defensively
  // — only return the value when `extras.headers[name]` is genuinely a string.
  const extras = message.extras as { headers?: Record<string, unknown> } | undefined;
  const value = extras?.headers?.[name];
  return typeof value === 'string' ? value : undefined;
};
