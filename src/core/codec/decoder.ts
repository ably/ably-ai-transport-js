/**
 * Decoder core — action dispatch and serial tracking machinery.
 *
 * Handles the Ably message action patterns (create, append, update, delete)
 * and delegates to domain-specific hooks for event building and discrete
 * event decoding. Stream trackers are version-guarded: a delivery whose
 * `Message.version.serial` the tracker has already incorporated decodes to
 * nothing, so the same decoder instance can serve both the live
 * subscription and history hydration without double-decoding.
 *
 * Domain decoders call `createDecoderCore(hooks, options)` and provide hooks
 * for stream classification, event building, and discrete decoding. Hooks
 * return a flat `TEvent[]` — no event-vs-message union. Per-message routing
 * concerns (`codec-message-id`) are handled by the SDK via `ReducerMeta`, not
 * here.
 */

import type * as Ably from 'ably';

import { HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../constants.js';
import type { Logger } from '../../logger.js';
import { getCodecHeaders, getTransportHeaders } from '../../utils.js';
import type { MessagePayload, StreamTrackerState } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating a decoder core. */
export interface DecoderCoreOptions {
  /** Called when a tracked stream is replaced (non-prefix update). Receives the tracker with updated state. */
  onStreamUpdate?: (tracker: StreamTrackerState) => void;
  /** Called when a message is deleted. Receives the serial and tracker (if one exists). */
  onStreamDelete?: (serial: string, tracker: StreamTrackerState | undefined) => void;
  /** Logger instance for diagnostic output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Domain hooks
// ---------------------------------------------------------------------------

/** Hooks that a domain codec provides to the decoder core for stream classification and event building. */
export interface DecoderCoreHooks<TEvent> {
  /**
   * Build domain events emitted when a new stream starts. May return multiple
   * events (e.g. a start event and a start-step event).
   */
  buildStartEvents(tracker: StreamTrackerState): TEvent[];

  /** Build domain events for a text delta received on a stream. */
  buildDeltaEvents(tracker: StreamTrackerState, delta: string): TEvent[];

  /**
   * Build domain events emitted when a stream completes (status:complete).
   * Not called for cancelled streams. The closing codec headers may differ
   * from tracker.codecHeaders if the closing append carried updated headers.
   */
  buildEndEvents(tracker: StreamTrackerState, closingCodecHeaders: Record<string, string>): TEvent[];

  /**
   * Decode a discrete message (a `message.create` whose stream header is not
   * "true", or a non-streamable first-contact update). Handles user messages,
   * tool lifecycle, data-*, etc.
   */
  decodeDiscrete(input: MessagePayload): TEvent[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** The decoder core returned by {@link createDecoderCore}. */
export interface DecoderCore<TEvent> {
  /** Decode a single Ably message into zero or more domain TEvents. */
  decode(message: Ably.InboundMessage): TEvent[];
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CD7
class DefaultDecoderCore<TEvent> implements DecoderCore<TEvent> {
  private readonly _hooks: DecoderCoreHooks<TEvent>;
  private readonly _logger: Logger | undefined;
  private readonly _onStreamUpdate: ((tracker: StreamTrackerState) => void) | undefined;
  private readonly _onStreamDelete: ((serial: string, tracker: StreamTrackerState | undefined) => void) | undefined;
  private readonly _serialState = new Map<string, StreamTrackerState>();

  constructor(hooks: DecoderCoreHooks<TEvent>, options: DecoderCoreOptions = {}) {
    this._hooks = hooks;
    this._onStreamUpdate = options.onStreamUpdate;
    this._onStreamDelete = options.onStreamDelete;
    this._logger = options.logger?.withContext({ component: 'DecoderCore' });
  }

  decode(message: Ably.InboundMessage): TEvent[] {
    const action = message.action;

    this._logger?.trace('DefaultDecoderCore.decode();', { action, serial: message.serial, name: message.name });

    switch (action) {
      // Spec: AIT-CD7a
      case 'message.create': {
        const payload = this._toPayload(message);
        return payload.transportHeaders?.[HEADER_STREAM] === 'true'
          ? this._decodeStreamedCreate(payload, message.serial, message.version.serial)
          : this._hooks.decodeDiscrete(payload);
      }

      case 'message.append': {
        return this._decodeAppend(message);
      }

      case 'message.update': {
        return this._decodeUpdate(message);
      }

      case 'message.delete': {
        return this._decodeDelete(message);
      }

      default: {
        return [];
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: extract MessagePayload
  // -------------------------------------------------------------------------

  private _toPayload(message: Ably.InboundMessage): MessagePayload {
    return {
      name: message.name ?? '',
      // CAST: Ably SDK types `data` as `any`; cast to unknown is the safe boundary type.
      data: message.data as unknown,
      transportHeaders: getTransportHeaders(message),
      codecHeaders: getCodecHeaders(message),
    };
  }

  /**
   * Extract string data from an Ably message, for stream accumulation paths.
   * @param message - The Ably message to extract string data from.
   * @returns The string data, or empty string if data is not a string.
   */
  private _stringData(message: Ably.InboundMessage): string {
    return typeof message.data === 'string' ? message.data : '';
  }

  // -------------------------------------------------------------------------
  // Private: safe callback invocation
  // -------------------------------------------------------------------------

  private _invokeOnStreamUpdate(tracker: StreamTrackerState): void {
    if (!this._onStreamUpdate) return;
    try {
      this._onStreamUpdate(tracker);
    } catch (error) {
      this._logger?.error('DefaultDecoderCore._invokeOnStreamUpdate(); callback threw', { error });
    }
  }

  private _invokeOnStreamDelete(serial: string, tracker: StreamTrackerState | undefined): void {
    if (!this._onStreamDelete) return;
    try {
      this._onStreamDelete(serial, tracker);
    } catch (error) {
      this._logger?.error('DefaultDecoderCore._invokeOnStreamDelete(); callback threw', { error });
    }
  }

  // -------------------------------------------------------------------------
  // Private: version guard
  // -------------------------------------------------------------------------

  /**
   * Whether a delivery is already incorporated into (or out of contract for)
   * an existing tracker, and so must decode to nothing. Covers two cases:
   *
   * - The delivery carries a `version.serial` at or below the tracker's —
   *   the mutation it describes is already incorporated (a history aggregate
   *   covered by live deltas, a resume retransmission, a whole-wire replay).
   * - The tracker is closed — the stream has ended and its accumulated text
   *   has been dropped, so nothing further can fold into it. In-contract
   *   replays are already covered by the version check; this catches
   *   out-of-contract version-less deliveries for an ended stream.
   *
   * A version-bearing delivery that passes advances the tracker's version.
   * @param method - Calling method name, for log messages.
   * @param serial - The message serial (the tracker's key).
   * @param tracker - The existing tracker for the serial.
   * @param version - The delivery's `Message.version.serial`, if present.
   * @returns True when the delivery must decode to nothing.
   */
  private _alreadyIncorporated(
    method: string,
    serial: string,
    tracker: StreamTrackerState,
    version: string | undefined,
  ): boolean {
    if (version !== undefined && version <= tracker.version) {
      this._logger?.debug(`DefaultDecoderCore.${method}(); delivery already incorporated`, {
        serial,
        version,
        trackerVersion: tracker.version,
      });
      return true;
    }
    if (tracker.closed) {
      this._logger?.debug(`DefaultDecoderCore.${method}(); stream closed, dropping delivery`, { serial, version });
      return true;
    }
    if (version !== undefined) tracker.version = version;
    return false;
  }

  /**
   * Close a tracker, dropping its accumulated text. What remains is a
   * `{version, closed}` tombstone: enough to recognise covered replays and
   * out-of-contract post-close deliveries, without retaining the stream's
   * full content for the decoder's lifetime.
   * @param tracker - The tracker to close.
   */
  private _closeTracker(tracker: StreamTrackerState): void {
    tracker.closed = true;
    tracker.accumulated = '';
  }

  // -------------------------------------------------------------------------
  // Private: streamed message create
  // -------------------------------------------------------------------------

  private _decodeStreamedCreate(
    payload: MessagePayload,
    serial: string | undefined,
    version: string | undefined,
  ): TEvent[] {
    if (!serial) return [];

    const existing = this._serialState.get(serial);
    if (existing) {
      // A create is the message's first version, so a tracker for this serial
      // has already incorporated it (resume retransmission, whole-wire replay).
      this._logger?.debug('DefaultDecoderCore._decodeStreamedCreate(); duplicate create for tracked stream', {
        serial,
      });
      return [];
    }

    const streamId = payload.transportHeaders?.[HEADER_STREAM_ID] ?? '';

    const tracker: StreamTrackerState = {
      name: payload.name,
      streamId,
      accumulated: '',
      codecHeaders: { ...payload.codecHeaders },
      transportHeaders: { ...payload.transportHeaders },
      version: version ?? serial,
      closed: false,
    };
    this._serialState.set(serial, tracker);

    this._logger?.debug('DefaultDecoderCore._decodeStreamedCreate(); new stream', {
      name: payload.name,
      streamId,
      serial,
    });

    return this._hooks.buildStartEvents(tracker);
  }

  // -------------------------------------------------------------------------
  // Private: append handling
  // -------------------------------------------------------------------------

  // Spec: AIT-CD8
  private _decodeAppend(message: Ably.InboundMessage): TEvent[] {
    const serial = message.serial;
    if (!serial) return [];

    const tracker = this._serialState.get(serial);
    if (!tracker) {
      // Out of contract: the platform converts the first post-attach append
      // of an in-flight message into a full-contents update, so an append
      // should never be a stream's first contact. Keep the first-contact
      // heuristic as a defensive fallback.
      this._logger?.warn('DefaultDecoderCore._decodeAppend(); append with no tracker, treating as first contact', {
        serial,
      });
      return this._decodeUpdate(message);
    }

    if (this._alreadyIncorporated('_decodeAppend', serial, tracker, message.version.serial)) return [];

    const transport = getTransportHeaders(message);
    const closingCodec = getCodecHeaders(message);
    const delta = typeof message.data === 'string' ? message.data : '';
    const status = transport[HEADER_STATUS];
    const outputs: TEvent[] = [];

    if (delta.length > 0) {
      tracker.accumulated += delta;
      outputs.push(...this._hooks.buildDeltaEvents(tracker, delta));
    }

    if (status === 'complete') {
      outputs.push(...this._hooks.buildEndEvents(tracker, closingCodec));
      this._closeTracker(tracker);
      this._logger?.debug('DefaultDecoderCore._decodeAppend(); stream complete', { streamId: tracker.streamId });
    } else if (status === 'cancelled') {
      this._closeTracker(tracker);
      this._logger?.debug('DefaultDecoderCore._decodeAppend(); stream cancelled', { streamId: tracker.streamId });
    }

    return outputs;
  }

  // -------------------------------------------------------------------------
  // Private: update handling (first-contact, prefix-match, replacement)
  // -------------------------------------------------------------------------

  // Spec: AIT-CD9
  private _decodeUpdate(message: Ably.InboundMessage): TEvent[] {
    const serial = message.serial;
    if (!serial) return [];

    const payload = this._toPayload(message);
    const transport = payload.transportHeaders ?? {};
    const codec = payload.codecHeaders ?? {};
    const isStreamed = transport[HEADER_STREAM] === 'true';
    const status = transport[HEADER_STATUS];

    const tracker = this._serialState.get(serial);

    if (!tracker) {
      return this._decodeFirstContact(payload, isStreamed, status, serial, message.version.serial);
    }

    if (this._alreadyIncorporated('_decodeUpdate', serial, tracker, message.version.serial)) return [];

    // Updates to tracked streams use string data for prefix-match accumulation
    const data = this._stringData(message);

    // --- Tracker exists: prefix-match or replacement ---
    if (data.startsWith(tracker.accumulated)) {
      const delta = data.slice(tracker.accumulated.length);
      const outputs: TEvent[] = [];

      if (delta.length > 0) {
        tracker.accumulated = data;
        outputs.push(...this._hooks.buildDeltaEvents(tracker, delta));
      }

      if (status === 'complete') {
        outputs.push(...this._hooks.buildEndEvents(tracker, codec));
        this._closeTracker(tracker);
      } else if (status === 'cancelled') {
        this._closeTracker(tracker);
      }

      return outputs;
    }

    // --- Replacement (NOT a prefix match) ---
    tracker.accumulated = data;
    tracker.codecHeaders = { ...codec };
    tracker.transportHeaders = { ...transport };

    this._invokeOnStreamUpdate(tracker);

    return [];
  }

  private _decodeFirstContact(
    payload: MessagePayload,
    isStreamed: boolean,
    status: string | undefined,
    serial: string,
    version: string | undefined,
  ): TEvent[] {
    // Non-streamed messages are discrete
    if (!isStreamed) {
      return this._hooks.decodeDiscrete(payload);
    }

    const streamId = payload.transportHeaders?.[HEADER_STREAM_ID] ?? '';
    const codec = payload.codecHeaders ?? {};
    const data = typeof payload.data === 'string' ? payload.data : '';

    this._logger?.debug('DefaultDecoderCore._decodeFirstContact(); first-contact stream', {
      name: payload.name,
      streamId,
      serial,
    });

    // Create tracker
    const newTracker: StreamTrackerState = {
      name: payload.name,
      streamId,
      accumulated: data,
      codecHeaders: { ...codec },
      transportHeaders: { ...payload.transportHeaders },
      version: version ?? serial,
      closed: false,
    };
    this._serialState.set(serial, newTracker);

    // Emit start + delta (if any) + end (if complete)
    const outputs = this._hooks.buildStartEvents(newTracker);

    if (data.length > 0) {
      outputs.push(...this._hooks.buildDeltaEvents(newTracker, data));
    }

    if (status === 'complete') {
      outputs.push(...this._hooks.buildEndEvents(newTracker, codec));
    }

    if (status === 'complete' || status === 'cancelled') {
      this._closeTracker(newTracker);
    }

    return outputs;
  }

  // -------------------------------------------------------------------------
  // Private: delete handling
  // -------------------------------------------------------------------------

  // Spec: AIT-CD10
  private _decodeDelete(message: Ably.InboundMessage): TEvent[] {
    const serial = message.serial;
    if (!serial) return [];

    const tracker = this._serialState.get(serial);

    this._invokeOnStreamDelete(serial, tracker);

    if (tracker) {
      // No need to advance the tracker's version here: `_closeTracker` leaves a
      // closed tombstone, and `_alreadyIncorporated`'s closed check drops every
      // later delivery regardless of version.
      this._closeTracker(tracker);
    }

    this._logger?.debug('DefaultDecoderCore._decodeDelete();', { serial });

    return [];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a decoder core with the given domain hooks.
 * @param hooks - Domain-specific hooks for stream classification, event building, and discrete decoding.
 * @param options - Decoder configuration (callbacks, logger).
 * @returns A new {@link DecoderCore} instance.
 */
export const createDecoderCore = <TEvent>(
  hooks: DecoderCoreHooks<TEvent>,
  options: DecoderCoreOptions = {},
): DecoderCore<TEvent> => new DefaultDecoderCore(hooks, options);
