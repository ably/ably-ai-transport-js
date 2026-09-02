/**
 * Encoder core — message append lifecycle machinery.
 *
 * Provides Ably primitives (publish, append, close, cancel, flush) that
 * domain-specific encoders wire their event types to.
 *
 * Domain encoders call `createEncoderCore(writer, options)` and use the
 * returned core to map domain events to Ably operations without
 * reimplementing the message append lifecycle.
 */

import * as Ably from 'ably';

import {
  HEADER_DISCRETE,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
  HEADER_TRANSPORT_MESSAGE_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, mergeHeaders } from '../../utils.js';
import type { ChannelWriter, EncoderOptions, Extras, MessagePayload, StreamPayload, WriteOptions } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating an encoder core. Extends {@link EncoderOptions} with a logger. */
export interface EncoderCoreOptions extends EncoderOptions {
  /** Logger instance for diagnostic output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Stream tracker (internal)
// ---------------------------------------------------------------------------

interface StreamState {
  serial: string;
  name: string;
  streamId: string;
  accumulated: string;
  /** Transport-tier headers repeated on every append (`extras.ai.transport`). */
  persistentTransport: Record<string, string>;
  /** Codec-tier headers repeated on every append (`extras.ai.codec`). */
  persistentCodec: Record<string, string>;
  cancelled: boolean;
  /** Set by `closeStream` — a completed stream must never receive a cancelled terminal. */
  completed: boolean;
}

/**
 * The SDK's `extras.ai` namespace as written to the wire: a `transport` tier
 * (always present on SDK-published messages) and an optional `codec` tier.
 */
interface AiExtras {
  transport: Record<string, string>;
  codec?: Record<string, string>;
}

interface PendingAppend {
  promise: Promise<Ably.UpdateDeleteResult>;
  streamId: string;
}

// ---------------------------------------------------------------------------
// Encoder core interface
// ---------------------------------------------------------------------------

/** The core encoder primitives that domain codec encoders delegate to. */
export interface EncoderCore {
  /**
   * Publish a single discrete (non-streaming) message described by a payload.
   * @throws {Ably.ErrorInfo} SessionClosed if the core is closed.
   */
  publishDiscrete(payload: MessagePayload, opts?: WriteOptions): Promise<Ably.PublishResult>;

  /**
   * Publish multiple discrete messages atomically in a single channel publish.
   * @throws {Ably.ErrorInfo} SessionClosed if the core is closed.
   */
  publishDiscreteBatch(payloads: MessagePayload[], opts?: WriteOptions): Promise<Ably.PublishResult>;

  /**
   * Start a streamed message with status:streaming.
   * @throws {Ably.ErrorInfo} SessionClosed if the core is closed; InternalError if the publish succeeds but returns no serial.
   */
  startStream(streamId: string, payload: StreamPayload, opts?: WriteOptions): Promise<void>;

  /**
   * Append data to an in-flight streamed message. Fire-and-forget: errors are
   * collected internally and surfaced by {@link closeStream},
   * {@link cancelAllStreams} or {@link close}.
   * @throws {Ably.ErrorInfo} InvalidArgument if there is no active stream for `streamId`; SessionClosed if the core is closed.
   */
  appendStream(streamId: string, data: string): void;

  /**
   * Close a streamed message with status:complete. Flushes all pending
   * appends for recovery before returning. Repeats persistent and payload headers.
   * @throws {Ably.ErrorInfo} InvalidArgument if there is no active stream for `streamId`; SessionClosed if the encoder has been closed; StreamedMessageFinalizeFailed if a failed append cannot be recovered during the flush.
   */
  closeStream(streamId: string, payload: StreamPayload): Promise<void>;

  /**
   * Cancel all in-progress streams (status:cancelled) and flush all
   * pending appends for recovery before returning.
   * @throws {Ably.ErrorInfo} SessionClosed if the core is closed; StreamedMessageFinalizeFailed if a failed append cannot be recovered during the flush.
   */
  cancelAllStreams(opts?: WriteOptions): Promise<void>;

  /** Flush + clear trackers. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CD1
class DefaultEncoderCore implements EncoderCore {
  private readonly _writer: ChannelWriter;
  private readonly _defaultExtras: Extras | undefined;
  private readonly _onAblyMessageHook: (message: Ably.Message) => void;
  private readonly _logger: Logger | undefined;
  private readonly _trackers = new Map<string, StreamState>();
  private _pending: PendingAppend[] = [];
  private _flushPromise: Promise<void> | undefined;
  private _closed = false;

  constructor(writer: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._writer = writer;
    this._defaultExtras = options.extras;
    this._onAblyMessageHook =
      options.onAblyMessage ??
      (() => {
        /* noop */
      });
    this._logger = options.logger?.withContext({ component: 'EncoderCore' });
  }

  // Spec: AIT-CD11
  async publishDiscrete(payload: MessagePayload, opts?: WriteOptions): Promise<Ably.PublishResult> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.publishDiscrete();', { name: payload.name });
    const msg = this._buildDiscreteMessage(payload, opts);
    return this._writer.publish(msg);
  }

  // Spec: AIT-CD11a
  async publishDiscreteBatch(payloads: MessagePayload[], opts?: WriteOptions): Promise<Ably.PublishResult> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.publishDiscreteBatch();', { count: payloads.length });
    const msgs = payloads.map((p) => this._buildDiscreteMessage(p, opts, true));
    return this._writer.publish(msgs);
  }

  // Spec: AIT-CD2
  async startStream(streamId: string, payload: StreamPayload, opts?: WriteOptions): Promise<void> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.startStream();', { name: payload.name, streamId });

    const transport = this._buildTransport(payload.transportHeaders, opts);
    transport[HEADER_STREAM] = 'true';
    transport[HEADER_STATUS] = 'streaming';
    transport[HEADER_STREAM_ID] = streamId;
    const codec = payload.codecHeaders ?? {};

    const msg: Ably.Message = {
      name: payload.name,
      data: payload.data,
      extras: { ai: this._aiExtras(transport, codec) },
    };

    this._invokeOnAblyMessage(msg);
    const result = await this._writer.publish(msg);
    const serial = result.serials[0];

    // Spec: AIT-CD2a
    if (!serial) {
      throw new Ably.ErrorInfo(
        `unable to start stream; no serial returned for stream '${payload.name}' (streamId: ${streamId})`,
        ErrorCode.InternalError,
        500,
      );
    }

    this._trackers.set(streamId, {
      serial,
      name: payload.name,
      streamId,
      accumulated: payload.data,
      persistentTransport: transport,
      persistentCodec: codec,
      cancelled: false,
      completed: false,
    });

    this._logger?.debug('DefaultEncoderCore.startStream(); stream started', {
      name: payload.name,
      streamId,
      serial,
    });
  }

  // Spec: AIT-CD3
  appendStream(streamId: string, data: string): void {
    this._assertNotClosed();
    // Spec: AIT-CD3a
    const tracker = this._trackers.get(streamId);
    if (!tracker) {
      throw new Ably.ErrorInfo(
        `unable to append to stream; no active stream for streamId '${streamId}'`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    tracker.accumulated += data;

    const appendMsg: Ably.Message = {
      serial: tracker.serial,
      data,
      extras: { ai: this._aiExtras({ ...tracker.persistentTransport }, { ...tracker.persistentCodec }) },
    };

    this._invokeOnAblyMessage(appendMsg);
    const p = this._writer.appendMessage(appendMsg);
    this._pending.push({ promise: p, streamId });
  }

  // Spec: AIT-CD4, AIT-CD4a
  async closeStream(streamId: string, payload: StreamPayload): Promise<void> {
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

    // Accumulate closing data so recovery has the full content
    tracker.accumulated += payload.data;
    // Mark completed so a later cancelAllStreams (e.g. pipeStream terminating
    // streams left open by an agent self-abort) skips this stream.
    tracker.completed = true;

    const { transport, codec } = this._buildClosing(tracker, payload);
    transport[HEADER_STATUS] = 'complete';

    const msg: Ably.Message = {
      serial: tracker.serial,
      data: payload.data,
      extras: { ai: this._aiExtras(transport, codec) },
    };

    this._invokeOnAblyMessage(msg);
    const p = this._writer.appendMessage(msg);
    this._pending.push({ promise: p, streamId });

    await this._flushPending();

    this._logger?.debug('DefaultEncoderCore.closeStream(); stream closed', { streamId });
  }

  // Spec: AIT-CD5, AIT-CD5a
  async cancelAllStreams(opts?: WriteOptions): Promise<void> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.cancelAllStreams();', { streamCount: this._trackers.size });

    for (const tracker of this._trackers.values()) {
      // Idempotent and complete-safe: a stream already cancelled must not be
      // re-appended on a repeat call, and a stream that closed with
      // status:complete must never receive a cancelled terminal.
      if (tracker.cancelled || tracker.completed) continue;
      tracker.cancelled = true;

      const { transport, codec } = this._buildClosing(tracker, undefined, opts);
      transport[HEADER_STATUS] = 'cancelled';

      const msg: Ably.Message = {
        serial: tracker.serial,
        data: '',
        extras: { ai: this._aiExtras(transport, codec) },
      };

      this._invokeOnAblyMessage(msg);
      const p = this._writer.appendMessage(msg);
      this._pending.push({ promise: p, streamId: tracker.streamId });
    }

    await this._flushPending();
  }

  // Spec: AIT-CD6
  private async _flushPending(): Promise<void> {
    // Re-entrancy guard: if a flush is already in progress, await it instead of starting a new one.
    if (this._flushPromise) {
      return this._flushPromise;
    }

    const snapshot = this._pending;
    this._pending = [];

    if (snapshot.length === 0) return;

    this._logger?.trace('DefaultEncoderCore._flushPending();', { count: snapshot.length });

    this._flushPromise = this._doFlush(snapshot);
    try {
      await this._flushPromise;
    } finally {
      this._flushPromise = undefined;
    }
  }

  private async _doFlush(snapshot: PendingAppend[]): Promise<void> {
    const results = await Promise.allSettled(snapshot.map(async (p) => p.promise));
    const failures = new Set<string>();

    for (const [i, result] of results.entries()) {
      const entry = snapshot[i];
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

      // The tracker's actual state, never an assumed terminal: `_pending` is
      // shared by every stream, so the flush a closing stream triggers also
      // recovers other streams' failed appends — and a stream that is still
      // streaming must not be stamped `complete`, which would close every
      // subscriber's tracker and silently drop the rest of its output.
      // `streaming` is the create's own status, so existing decoders treat the
      // recovered stream as still open and the recovery update becomes a pure
      // prefix extension.
      const recoveryStatus = tracker.completed ? 'complete' : tracker.cancelled ? 'cancelled' : 'streaming';
      const msg: Ably.Message = {
        serial: tracker.serial,
        data: tracker.accumulated,
        extras: {
          ai: this._aiExtras(
            { ...tracker.persistentTransport, [HEADER_STATUS]: recoveryStatus },
            { ...tracker.persistentCodec },
          ),
        },
      };

      try {
        await this._writer.updateMessage(msg);
      } catch (error) {
        recoveryErrors.push({ streamId, error });
      }
    }

    if (recoveryErrors.length > 0) {
      const ids = recoveryErrors.map((e) => e.streamId).join(', ');
      this._logger?.error('DefaultEncoderCore._flushPending(); recovery failed', { failedStreams: ids });
      throw new Ably.ErrorInfo(
        `unable to flush pending appends; recovery failed for stream(s): ${ids}`,
        ErrorCode.StreamedMessageFinalizeFailed,
        500,
        errorCause(recoveryErrors[0]?.error),
      );
    }
  }

  // Spec: AIT-CD12
  async close(): Promise<void> {
    if (this._closed) return;
    this._logger?.trace('DefaultEncoderCore.close();');
    this._closed = true;
    try {
      await this._flushPending();
    } finally {
      this._trackers.clear();
    }
    this._logger?.debug('DefaultEncoderCore.close(); encoder closed');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  // Spec: AIT-CD14
  private _invokeOnAblyMessage(msg: Ably.Message): void {
    try {
      this._onAblyMessageHook(msg);
    } catch (error) {
      this._logger?.error('DefaultEncoderCore._invokeOnAblyMessage(); hook threw', { error });
    }
  }

  private _assertNotClosed(): void {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to write to encoder; encoder has been closed', ErrorCode.SessionClosed, 400);
    }
  }

  /**
   * Build the transport-tier header record for a message: caller-configured
   * transport headers (default extras + per-write overrides) layered with any
   * transport headers the codec payload stamps directly, plus the message-id.
   * @param payloadTransport - Transport headers carried on the codec payload.
   * @param opts - Optional per-write overrides.
   * @returns The transport-tier headers record (`extras.ai.transport`).
   */
  private _buildTransport(
    payloadTransport: Record<string, string> | undefined,
    opts?: WriteOptions,
  ): Record<string, string> {
    const callerHeaders = mergeHeaders(this._defaultExtras?.headers, opts?.extras?.headers);
    const transport = { ...callerHeaders, ...payloadTransport };
    if (opts?.messageId !== undefined) {
      transport[HEADER_TRANSPORT_MESSAGE_ID] = opts.messageId;
    }
    return transport;
  }

  /**
   * Assemble the `extras.ai` namespace from its two tiers, omitting the codec
   * tier when empty.
   * @param transport - Transport-tier headers (always present on SDK messages).
   * @param codec - Codec-tier headers; omitted from the wire when empty.
   * @returns The `extras.ai` object.
   */
  private _aiExtras(transport: Record<string, string>, codec: Record<string, string>): AiExtras {
    return Object.keys(codec).length > 0 ? { transport, codec } : { transport };
  }

  private _buildDiscreteMessage(payload: MessagePayload, opts?: WriteOptions, discrete = false): Ably.Message {
    const transport = this._buildTransport(payload.transportHeaders, opts);
    transport[HEADER_STREAM] = 'false';
    if (discrete) {
      // Mark batch-published payloads as discrete message parts (from writeMessages).
      // The decoder relies on this header to distinguish message parts from lifecycle
      // events that also happen to be discrete (stream: false).
      transport[HEADER_DISCRETE] = 'true';
    }
    const msg: Ably.Message = {
      name: payload.name,
      data: payload.data,
      extras: {
        ai: this._aiExtras(transport, payload.codecHeaders ?? {}),
        ...(payload.ephemeral ? { ephemeral: true } : {}),
      },
    };

    this._invokeOnAblyMessage(msg);
    return msg;
  }

  /**
   * Build both header tiers for a closing append. Closing appends must repeat
   * ALL persistent headers (Ably replaces the entire extras object on append).
   * Then layer caller and codec overrides.
   * @param tracker - The stream tracker with persistent headers.
   * @param payload - The closing stream payload (codec + transport headers).
   * @param opts - Optional per-write overrides.
   * @returns The two tiers for the closing append.
   */
  private _buildClosing(
    tracker: StreamState,
    payload: StreamPayload | undefined,
    opts?: WriteOptions,
  ): { transport: Record<string, string>; codec: Record<string, string> } {
    const callerHeaders = mergeHeaders(this._defaultExtras?.headers, opts?.extras?.headers);
    const transport = { ...tracker.persistentTransport, ...callerHeaders, ...payload?.transportHeaders };
    const codec = { ...tracker.persistentCodec, ...payload?.codecHeaders };
    return { transport, codec };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an encoder core bound to the given channel writer.
 * @param writer - The channel writer to publish messages through.
 * @param options - Encoder configuration (extras, hooks, logger).
 * @returns A new {@link EncoderCore} instance.
 */
export const createEncoderCore = (writer: ChannelWriter, options: EncoderCoreOptions = {}): EncoderCore =>
  new DefaultEncoderCore(writer, options);
