/**
 * Encoder core — message append lifecycle machinery.
 *
 * Provides Ably primitives (publish, append, close, abort, flush) that
 * domain-specific encoders wire their event types to.
 *
 * Domain encoders call `createEncoderCore(writer, options)` and use the
 * returned core to map domain events to Ably operations without
 * reimplementing the message append lifecycle.
 */

import * as Ably from 'ably';

import { HEADER_MSG_ID, HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { mergeHeaders } from '../../utils.js';
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
  persistentHeaders: Record<string, string>;
  aborted: boolean;
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
  /** Publish a single discrete (non-streaming) message described by a payload. */
  publishDiscrete(payload: MessagePayload, opts?: WriteOptions): Promise<Ably.PublishResult>;

  /** Publish multiple discrete messages atomically in a single channel publish. */
  publishDiscreteBatch(payloads: MessagePayload[], opts?: WriteOptions): Promise<Ably.PublishResult>;

  /** Start a streamed message with x-ably-status:streaming. */
  startStream(streamId: string, payload: StreamPayload, opts?: WriteOptions): Promise<void>;

  /**
   * Append data to an in-flight streamed message. Fire-and-forget: errors are
   * collected internally and surfaced by {@link closeStream} or {@link close}.
   */
  appendStream(streamId: string, data: string): void;

  /**
   * Close a streamed message with x-ably-status:finished. Flushes all pending
   * appends for recovery before returning. Repeats persistent and payload headers.
   */
  closeStream(streamId: string, payload: StreamPayload): Promise<void>;

  /**
   * Abort a single in-progress stream (x-ably-status:aborted) and flush all
   * pending appends for recovery before returning.
   */
  abortStream(streamId: string, opts?: WriteOptions): Promise<void>;

  /**
   * Abort all in-progress streams (x-ably-status:aborted) and flush all
   * pending appends for recovery before returning.
   */
  abortAllStreams(opts?: WriteOptions): Promise<void>;

  /** Flush + clear trackers. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CD1
class DefaultEncoderCore implements EncoderCore {
  private readonly _writer: ChannelWriter;
  private readonly _defaultClientId: string | undefined;
  private readonly _defaultExtras: Extras | undefined;
  private readonly _onMessageHook: (message: Ably.Message) => void;
  private readonly _logger: Logger | undefined;
  private readonly _trackers = new Map<string, StreamState>();
  private _pending: PendingAppend[] = [];
  private _flushPromise: Promise<void> | undefined;
  private _closed = false;

  constructor(writer: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._writer = writer;
    this._defaultClientId = options.clientId;
    this._defaultExtras = options.extras;
    this._onMessageHook =
      options.onMessage ??
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
    const msgs = payloads.map((p) => this._buildDiscreteMessage(p, opts));
    return this._writer.publish(msgs);
  }

  // Spec: AIT-CD2
  async startStream(streamId: string, payload: StreamPayload, opts?: WriteOptions): Promise<void> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.startStream();', { name: payload.name, streamId });

    const allHeaders = this._buildHeaders(payload.headers ?? {}, opts);
    allHeaders[HEADER_STREAM] = 'true';
    allHeaders[HEADER_STATUS] = 'streaming';
    allHeaders[HEADER_STREAM_ID] = streamId;

    const clientId = this._resolveClientId(opts);
    const msg: Ably.Message = {
      name: payload.name,
      data: payload.data,
      extras: { headers: allHeaders },
      ...(clientId ? { clientId } : {}),
    };

    this._invokeOnMessage(msg);
    const result = await this._writer.publish(msg);
    const serial = result.serials[0];

    if (!serial) {
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
      persistentHeaders: allHeaders,
      aborted: false,
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
      extras: { headers: { ...tracker.persistentHeaders } },
    };

    this._invokeOnMessage(appendMsg);
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

    const allHeaders = this._buildClosingHeaders(tracker, payload.headers ?? {});
    allHeaders[HEADER_STATUS] = 'finished';

    const msg: Ably.Message = {
      serial: tracker.serial,
      data: payload.data,
      extras: { headers: allHeaders },
    };

    this._invokeOnMessage(msg);
    const p = this._writer.appendMessage(msg);
    this._pending.push({ promise: p, streamId });

    await this._flushPending();

    this._logger?.debug('DefaultEncoderCore.closeStream(); stream closed', { streamId });
  }

  // Spec: AIT-CD5, AIT-CD5b
  async abortStream(streamId: string, opts?: WriteOptions): Promise<void> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.abortStream();', { streamId });

    const tracker = this._trackers.get(streamId);
    if (!tracker) {
      throw new Ably.ErrorInfo(
        `unable to abort stream; no active stream for streamId '${streamId}'`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    tracker.aborted = true;

    const allHeaders = this._buildClosingHeaders(tracker, {}, opts);
    allHeaders[HEADER_STATUS] = 'aborted';

    const msg: Ably.Message = {
      serial: tracker.serial,
      data: '',
      extras: { headers: allHeaders },
    };

    this._invokeOnMessage(msg);
    const p = this._writer.appendMessage(msg);
    this._pending.push({ promise: p, streamId });

    await this._flushPending();

    this._logger?.debug('DefaultEncoderCore.abortStream(); stream aborted', { streamId });
  }

  // Spec: AIT-CD5a
  async abortAllStreams(opts?: WriteOptions): Promise<void> {
    this._assertNotClosed();
    this._logger?.trace('DefaultEncoderCore.abortAllStreams();', { streamCount: this._trackers.size });

    for (const tracker of this._trackers.values()) {
      tracker.aborted = true;

      const allHeaders = this._buildClosingHeaders(tracker, {}, opts);
      allHeaders[HEADER_STATUS] = 'aborted';

      const msg: Ably.Message = {
        serial: tracker.serial,
        data: '',
        extras: { headers: allHeaders },
      };

      this._invokeOnMessage(msg);
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

      const recoveryStatus = tracker.aborted ? 'aborted' : 'finished';
      const msg: Ably.Message = {
        serial: tracker.serial,
        data: tracker.accumulated,
        extras: { headers: { ...tracker.persistentHeaders, [HEADER_STATUS]: recoveryStatus } },
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
        ErrorCode.EncoderRecoveryFailed,
        500,
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
  private _invokeOnMessage(msg: Ably.Message): void {
    try {
      this._onMessageHook(msg);
    } catch (error) {
      this._logger?.error('DefaultEncoderCore._invokeOnMessage(); hook threw', { error });
    }
  }

  private _assertNotClosed(): void {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to write to encoder; encoder has been closed', ErrorCode.InvalidArgument, 400);
    }
  }

  private _resolveClientId(opts?: WriteOptions): string | undefined {
    return opts?.clientId ?? this._defaultClientId;
  }

  private _buildHeaders(codecHeaders: Record<string, string>, opts?: WriteOptions): Record<string, string> {
    const callerHeaders = mergeHeaders(this._defaultExtras?.headers, opts?.extras?.headers);
    const merged = { ...callerHeaders, ...codecHeaders };
    if (opts?.messageId !== undefined) {
      merged[HEADER_MSG_ID] = opts.messageId;
    }
    return merged;
  }

  private _buildDiscreteMessage(payload: MessagePayload, opts?: WriteOptions): Ably.Message {
    const headers = this._buildHeaders(payload.headers ?? {}, opts);
    headers[HEADER_STREAM] = 'false';
    const clientId = this._resolveClientId(opts);

    const msg: Ably.Message = {
      name: payload.name,
      data: payload.data,
      extras: {
        headers,
        ...(payload.ephemeral ? { ephemeral: true } : {}),
      },
      ...(clientId ? { clientId } : {}),
    };

    this._invokeOnMessage(msg);
    return msg;
  }

  /**
   * Build headers for a closing append. Closing appends must repeat ALL
   * persistent headers (Ably replaces the entire extras object on append).
   * Then layer caller and codec overrides.
   * @param tracker - The stream tracker with persistent headers.
   * @param codecHeaders - Codec-layer headers to merge.
   * @param opts - Optional per-write overrides.
   * @returns Merged headers for the closing append.
   */
  private _buildClosingHeaders(
    tracker: StreamState,
    codecHeaders: Record<string, string>,
    opts?: WriteOptions,
  ): Record<string, string> {
    const h = { ...tracker.persistentHeaders };
    const callerHeaders = mergeHeaders(this._defaultExtras?.headers, opts?.extras?.headers);
    Object.assign(h, callerHeaders);
    Object.assign(h, codecHeaders);
    return h;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an encoder core bound to the given channel writer.
 * @param writer - The channel writer to publish messages through.
 * @param options - Encoder configuration (clientId, extras, hooks, logger).
 * @returns A new {@link EncoderCore} instance.
 */
export const createEncoderCore = (writer: ChannelWriter, options: EncoderCoreOptions = {}): EncoderCore =>
  new DefaultEncoderCore(writer, options);
