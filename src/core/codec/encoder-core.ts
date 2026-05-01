import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { Headers } from '../../headers.js';
import type { Logger } from '../../logger.js';
import type { ChannelWriter } from './types.js';

/**
 * Per-call options for the encoder core's content-emitting primitives.
 * Mirrors the public {@link import('./types.js').EncodeOptions} surface
 * with one extra codec-only field — `ephemeral`. Codecs map `data-*`
 * parts whose `transient === true` onto this flag when calling the core.
 */
export interface CoreEncodeOptions {
  /**
   * Headers stamped on every wire emitted by the call. The codec passes
   * the merged set of `x-domain-*` codec headers and `x-ably-*` SDK
   * headers; the core stamps them onto the outgoing wire and (for streams)
   * captures them as the stream's persistent headers for re-application
   * on every subsequent append/close.
   */
  headers?: Record<string, string>;
  /**
   * Mark the wire message as ephemeral — Ably will deliver it to attached
   * subscribers but won't persist it to channel history.
   */
  ephemeral?: boolean;
}

/**
 * Payload describing a discrete (non-streaming) wire emitted by the
 * codec. The codec's `name` and `data` are the on-wire shape; the core
 * adds the SDK-owned framing (`x-ably-stream:'false'`, headers, extras).
 */
export interface DiscretePayload {
  /** Ably message name (e.g. `'text'`, `'tool-output-available'`). */
  name: string;
  /** Message data (string or JSON-serialisable object). Ably handles serialisation. */
  data: unknown;
}

/**
 * Payload for streamed wires. `data` is restricted to a string because
 * the message-append wire model uses text append-by-concatenation
 * semantics — recovery via `updateMessage` re-publishes the accumulated
 * buffer, which only round-trips cleanly when each delta is a string.
 */
export interface StreamPayload {
  /** Ably message name (e.g. `'text'`, `'reasoning'`, `'tool-input'`). */
  name: string;
  /** Initial / closing data for the stream. Empty string is the canonical "no payload" value. */
  data: string;
}

/**
 * Stateful primitives that drive Ably's message-create + message-append
 * wire model. Domain codecs route every wire through this surface — the
 * core handles framing (stream/status/streamId headers), the recovery
 * path on append failure, and the auto-abort of any still-open streams
 * on `close()`.
 *
 * An encoder core is bound to one {@link ChannelWriter} for its lifetime;
 * every method does I/O directly through that writer.
 */
export interface EncoderCore {
  /**
   * Publish one discrete `message.create` wire. The core sets
   * `x-ably-stream:'false'`, merges `options.headers` onto `extras.headers`,
   * and attaches `extras.ephemeral` when requested.
   * @param payload The wire payload — `name` and `data`.
   * @param options Per-call wiring; see {@link CoreEncodeOptions}.
   * @returns The Ably publish result, including the server-assigned serial.
   */
  publish(payload: DiscretePayload, options?: CoreEncodeOptions): Promise<Ably.PublishResult>;

  /**
   * Publish a batch of discrete `message.create` wires atomically — one
   * `channel.publish([...])` call. The core stamps `x-ably-discrete:'true'`
   * on every wire so the decoder can distinguish complete-message parts
   * from lifecycle chunks of the same name.
   * @param payloads The wire payloads.
   * @param options Per-call wiring applied uniformly to every payload.
   * @returns The Ably publish result with one serial per payload.
   */
  publishBatch(payloads: DiscretePayload[], options?: CoreEncodeOptions): Promise<Ably.PublishResult>;

  /**
   * Open a stream — publishes a `message.create` with
   * `x-ably-stream:'true'`, `x-ably-stream-id:streamId`, and
   * `x-ably-status:'streaming'`. Resolves once Ably has acknowledged the
   * create; the core captures the server-assigned serial in an internal
   * tracker for later append/close calls. The merged headers (payload
   * headers, if any, plus `options.headers`) are captured as the stream's
   * persistent headers and re-applied on every subsequent append/close.
   * @param streamId Stable identity the codec uses for append/close lookups.
   * @param payload The streaming wire payload — `name` and initial `data`.
   * @param options Per-call wiring; see {@link CoreEncodeOptions}.
   */
  startStream(streamId: string, payload: StreamPayload, options?: CoreEncodeOptions): Promise<void>;

  /**
   * Append delta data to an open stream — fire-and-forget
   * `channel.appendMessage` against the create's serial. The promise is
   * captured internally so subsequent {@link closeStream} / {@link close}
   * can flush and (on failure) recover via `channel.updateMessage` with
   * the accumulated buffer.
   *
   * Throws synchronously when `streamId` is unknown — this indicates a
   * caller bug (append without start).
   * @param streamId Identity of the open stream.
   * @param data Delta to append.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.InvalidArgument}
   *   when `streamId` does not match an open stream.
   */
  appendStream(streamId: string, data: string): void;

  /**
   * Close a stream — flushes pending appends, then publishes a
   * `message.append` with `x-ably-status:'finished'`. Closing-side
   * `options.headers` / `payload.headers` (if any) are merged on top of
   * the stream's persistent headers, letting codecs stamp end-of-stream
   * metadata (e.g. `providerMetadata`) without polluting the start.
   * @param streamId Identity of the open stream.
   * @param payload Closing payload — `name` and trailing `data`.
   * @param options Per-call wiring; see {@link CoreEncodeOptions}.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.InvalidArgument}
   *   when `streamId` does not match an open stream.
   * @throws An `Ably.ErrorInfo` with code
   *   {@link ErrorCode.EncoderRecoveryFailed} when an append rejected and
   *   the fallback `updateMessage` also rejected.
   */
  closeStream(streamId: string, payload: StreamPayload, options?: CoreEncodeOptions): Promise<void>;

  /**
   * Auto-abort every still-open stream (`x-ably-status:'aborted'`), drain
   * pending appends, and prevent any further use of the core. Idempotent —
   * subsequent calls resolve immediately.
   * @returns Resolves once every aborted close-append has flushed.
   */
  close(): Promise<void>;
}

/** Options for constructing an {@link EncoderCore}. */
export interface EncoderCoreOptions {
  /** Logger inherited by the core. */
  logger?: Logger;
}

/** Internal tracker for an open stream. */
interface StreamState {
  /** Server-assigned serial of the create. */
  serial: string;
  /** Ably message name; preserved for recovery `updateMessage`. */
  name: string;
  /** Stream identity supplied by the codec. */
  streamId: string;
  /** Full text accumulated across appends; load-bearing for recovery. */
  accumulated: string;
  /** Headers captured at start; re-applied on every append/close. */
  persistentHeaders: Record<string, string>;
  /** True once the close-append has been issued (finished or aborted). */
  closed: boolean;
  /** True when the close was via abort (vs. finished). */
  aborted: boolean;
}

/** A `channel.appendMessage` promise the core has yet to settle. */
interface PendingAppend {
  /** The fire-and-forget appendMessage promise. */
  promise: Promise<Ably.UpdateDeleteResult>;
  /** Stream this append targets — used to scope recovery on rejection. */
  streamId: string;
}

class DefaultEncoderCore implements EncoderCore {
  private readonly _channel: ChannelWriter;
  private readonly _logger: Logger | undefined;
  private readonly _trackers = new Map<string, StreamState>();
  private _pending: PendingAppend[] = [];
  private _flushPromise: Promise<void> | undefined;
  private _closed = false;

  constructor(channel: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._channel = channel;
    this._logger = options.logger?.withContext({ component: 'EncoderCore' });
  }

  async publish(payload: DiscretePayload, options?: CoreEncodeOptions): Promise<Ably.PublishResult> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.publish();', { name: payload.name });
    const wire = this._buildDiscrete(payload, options);
    return this._channel.publish(wire);
  }

  async publishBatch(payloads: DiscretePayload[], options?: CoreEncodeOptions): Promise<Ably.PublishResult> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.publishBatch();', { count: payloads.length });
    const wires = payloads.map((payload) => {
      const wire = this._buildDiscrete(payload, options);
      // CAST: _buildDiscrete sets `extras` with a known `{ headers }` shape.
      const extras = wire.extras as { headers: Record<string, string> };
      extras.headers[Headers.Discrete] = 'true';
      return wire;
    });
    return this._channel.publish(wires);
  }

  async startStream(streamId: string, payload: StreamPayload, options?: CoreEncodeOptions): Promise<void> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.startStream();', { name: payload.name, streamId });

    const headers: Record<string, string> = {
      ...options?.headers,
      [Headers.Stream]: 'true',
      [Headers.Status]: 'streaming',
      [Headers.StreamId]: streamId,
    };

    const wire: Ably.Message = {
      name: payload.name,
      data: payload.data,
      extras: { headers },
    };

    const result = await this._channel.publish(wire);
    // Ably types `serials[i]` as `string | null` — null indicates server-side
    // conflation, which our streaming wires don't opt into. Treat both
    // missing and null as a hard error.
    const serial = result.serials[0];
    if (typeof serial !== 'string') {
      throw new Ably.ErrorInfo(
        `unable to start stream; no serial returned for stream '${payload.name}' (streamId: ${streamId})`,
        ErrorCode.BadRequest,
        400,
      );
    }

    this._trackers.set(streamId, {
      serial,
      name: payload.name,
      streamId,
      accumulated: payload.data,
      persistentHeaders: headers,
      closed: false,
      aborted: false,
    });

    this._logger?.debug('DefaultEncoderCore.startStream(); stream started', {
      name: payload.name,
      streamId,
      serial,
    });
  }

  appendStream(streamId: string, data: string): void {
    this._assertNotClosed();
    const tracker = this._trackers.get(streamId);
    if (!tracker) {
      throw new Ably.ErrorInfo(
        `unable to append to stream; no active stream for streamId '${streamId}'`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    tracker.accumulated += data;

    const append: Ably.Message = {
      serial: tracker.serial,
      data,
      extras: { headers: { ...tracker.persistentHeaders } },
    };
    const promise = this._channel.appendMessage(append);
    this._pending.push({ promise, streamId });
  }

  async closeStream(streamId: string, payload: StreamPayload, options?: CoreEncodeOptions): Promise<void> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.closeStream();', { streamId });

    const tracker = this._trackers.get(streamId);
    if (!tracker) {
      throw new Ably.ErrorInfo(
        `unable to close stream; no active stream for streamId '${streamId}'`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    tracker.accumulated += payload.data;

    const headers: Record<string, string> = {
      ...tracker.persistentHeaders,
      ...options?.headers,
      [Headers.Status]: 'finished',
    };

    const close: Ably.Message = {
      serial: tracker.serial,
      data: payload.data,
      extras: { headers },
    };
    const promise = this._channel.appendMessage(close);
    this._pending.push({ promise, streamId });
    tracker.closed = true;

    await this._flushPending();

    this._logger?.debug('DefaultEncoderCore.closeStream(); stream closed', { streamId });
  }

  async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._logger?.trace('DefaultEncoderCore.close();');
    this._closed = true;

    for (const tracker of this._trackers.values()) {
      if (tracker.closed) {
        continue;
      }
      tracker.closed = true;
      tracker.aborted = true;

      const headers: Record<string, string> = { ...tracker.persistentHeaders, [Headers.Status]: 'aborted' };

      const close: Ably.Message = {
        serial: tracker.serial,
        data: '',
        extras: { headers },
      };
      const promise = this._channel.appendMessage(close);
      this._pending.push({ promise, streamId: tracker.streamId });
    }

    try {
      await this._flushPending();
    } finally {
      this._trackers.clear();
    }

    this._logger?.debug('DefaultEncoderCore.close(); encoder closed');
  }

  private _buildDiscrete(payload: DiscretePayload, options?: CoreEncodeOptions): Ably.Message {
    const headers: Record<string, string> = { ...options?.headers, [Headers.Stream]: 'false' };
    const extras: { headers: Record<string, string>; ephemeral?: boolean } = { headers };
    if (options?.ephemeral) {
      extras.ephemeral = true;
    }
    return {
      name: payload.name,
      data: payload.data,
      extras,
    };
  }

  private async _flushPending(): Promise<void> {
    // Re-entrancy guard — concurrent close()/closeStream() share one flush.
    if (this._flushPromise) {
      return this._flushPromise;
    }

    const snapshot = this._pending;
    this._pending = [];
    if (snapshot.length === 0) {
      return;
    }

    this._logger?.trace('DefaultEncoderCore._flushPending();', { count: snapshot.length });

    this._flushPromise = this._doFlush(snapshot);
    try {
      await this._flushPromise;
    } finally {
      this._flushPromise = undefined;
    }
  }

  private async _doFlush(snapshot: PendingAppend[]): Promise<void> {
    const results = await Promise.allSettled(snapshot.map(async (entry) => entry.promise));
    const failures = new Set<string>();
    for (const [index, result] of results.entries()) {
      const entry = snapshot[index];
      if (entry && result.status === 'rejected') {
        failures.add(entry.streamId);
      }
    }
    if (failures.size === 0) {
      this._logger?.debug('DefaultEncoderCore._flushPending(); all appends succeeded');
      return;
    }

    this._logger?.warn('DefaultEncoderCore._flushPending(); recovering failed appends', {
      failedStreams: [...failures],
    });

    const recoveryErrors: { streamId: string; error: unknown }[] = [];
    for (const streamId of failures) {
      const tracker = this._trackers.get(streamId);
      if (!tracker) continue;

      const recoveryStatus = tracker.aborted ? 'aborted' : 'finished';
      const recoveryHeaders: Record<string, string> = {
        ...tracker.persistentHeaders,
        [Headers.Status]: recoveryStatus,
      };

      const recovery: Ably.Message = {
        serial: tracker.serial,
        data: tracker.accumulated,
        extras: { headers: recoveryHeaders },
      };
      try {
        await this._channel.updateMessage(recovery);
      } catch (error) {
        recoveryErrors.push({ streamId, error });
      }
    }

    if (recoveryErrors.length > 0) {
      const ids = recoveryErrors.map((entry) => entry.streamId).join(', ');
      this._logger?.error('DefaultEncoderCore._flushPending(); recovery failed', { failedStreams: ids });
      throw new Ably.ErrorInfo(
        `unable to flush pending appends; recovery failed for stream(s): ${ids}`,
        ErrorCode.EncoderRecoveryFailed,
        500,
      );
    }
  }

  private _assertNotClosed(): void {
    if (this._closed) {
      throw new Ably.ErrorInfo(
        'unable to write to encoder core; encoder has been closed',
        ErrorCode.InvalidArgument,
        400,
      );
    }
  }
}

/**
 * Create an {@link EncoderCore} bound to the given channel writer.
 * @param channel The channel writer the core publishes through.
 * @param options Optional logger.
 * @returns A new encoder core.
 */
export const createEncoderCore = (channel: ChannelWriter, options?: EncoderCoreOptions): EncoderCore =>
  new DefaultEncoderCore(channel, options);
