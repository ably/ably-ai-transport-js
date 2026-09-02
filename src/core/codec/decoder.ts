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
 * Domain decoders call `createDecoderCore(hooks)` and provide hooks
 * for stream classification, event building, and discrete decoding. Hooks
 * return a flat `TEvent[]` — no event-vs-message union. Per-message routing
 * concerns (`transport-message-id`) are surfaced by the transport via `WireMeta`, not
 * here.
 */

import type * as Ably from 'ably';

import { HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../constants.js';
import type { Logger } from '../../logger.js';
import { getCodecHeaders, getTransportHeaders, hasAiEnvelope } from '../../utils.js';
import type { MessagePayload, StreamSequenceState } from './types.js';

// ---------------------------------------------------------------------------
// Domain hooks
// ---------------------------------------------------------------------------

/** Hooks that a domain codec provides to the decoder core for stream classification and event building. */
export interface DecoderCoreHooks<TEvent> {
  /**
   * Build domain events emitted when a new stream starts. May return multiple
   * events (e.g. a start event and a start-step event).
   */
  buildStartEvents(tracker: StreamSequenceState): TEvent[];

  /** Build domain events for a text delta received on a stream. */
  buildDeltaEvents(tracker: StreamSequenceState, delta: string): TEvent[];

  /**
   * Build domain events emitted when a stream completes (status:complete).
   * Not called for cancelled streams. The closing codec headers may differ
   * from tracker.codecHeaders if the closing append carried updated headers.
   */
  buildEndEvents(tracker: StreamSequenceState, closingCodecHeaders: Record<string, string>): TEvent[];

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
  private readonly _serialState = new Map<string, StreamSequenceState>();

  constructor(hooks: DecoderCoreHooks<TEvent>, logger?: Logger) {
    this._hooks = hooks;
    this._logger = logger?.withContext({ component: 'DecoderCore' });
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
   *   has been dropped, so nothing further can merge into it. In-contract
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
    tracker: StreamSequenceState,
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
  private _closeTracker(tracker: StreamSequenceState): void {
    tracker.closed = true;
    tracker.accumulated = '';
  }

  // -------------------------------------------------------------------------
  // Private: terminal-status transition
  // -------------------------------------------------------------------------

  /**
   * Apply a stream's terminal status (complete / cancelled) to a tracker. On
   * `complete` it emits end events (read before the tracker is closed) and
   * then closes the tracker; on `cancelled` it closes silently. Both the
   * append and prefix-match update paths funnel through here so they can't
   * diverge. Covered replays and post-close deliveries are filtered upstream
   * by `_alreadyIncorporated`, so no closed-once guard is needed here.
   * Returns whether a terminal transition fired (so callers can log it).
   * @param tracker - The stream tracker to close.
   * @param status - The status header value from the message (may be undefined).
   * @param closingCodecHeaders - Codec headers from the closing message, passed to buildEndEvents.
   * @param outputs - The output array end events are pushed into.
   * @returns True when this call closed the tracker; false otherwise.
   */
  private _applyTerminalStatus(
    tracker: StreamSequenceState,
    status: string | undefined,
    closingCodecHeaders: Record<string, string>,
    outputs: TEvent[],
  ): boolean {
    if (status === 'complete') {
      outputs.push(...this._hooks.buildEndEvents(tracker, closingCodecHeaders));
      this._closeTracker(tracker);
      return true;
    }
    if (status === 'cancelled') {
      this._closeTracker(tracker);
      return true;
    }
    return false;
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

    const tracker: StreamSequenceState = {
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
      // An append is the one action whose `name` the platform does not echo, so
      // a foreign append — an application streaming its own message on a
      // channel it shares with a transport — is identified by the absence of the
      // SDK's `extras.ai` envelope. It decodes to nothing, and says so at
      // debug: it is expected traffic, not the out-of-contract case below.
      if (!hasAiEnvelope(message)) {
        this._logger?.debug('DefaultDecoderCore._decodeAppend(); foreign append, ignoring', { serial });
        return [];
      }
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

    if (this._applyTerminalStatus(tracker, status, closingCodec, outputs)) {
      this._logger?.debug(
        `DefaultDecoderCore._decodeAppend(); stream ${status === 'complete' ? 'complete' : 'cancelled'}`,
        {
          streamId: tracker.streamId,
        },
      );
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

      this._applyTerminalStatus(tracker, status, codec, outputs);

      return outputs;
    }

    // --- Replacement (NOT a prefix match) ---
    // The payload diverged from what this decoder accumulated, so no delta
    // describes the change. No delta is emitted, and that is deliberate.
    //
    // A provider reducer can only append to an open part, so there are three
    // things this could do and two of them corrupt the consumer's view:
    //
    //   - Close the open group, then re-open it carrying the new content. The
    //     close is built from what the tracker holds, and a content-bearing
    //     end (Vercel's `tool-input-available`, OpenAI's `arguments`) would
    //     claim the stale partial as complete. A truncated tool-call argument
    //     presented as final is worse than no update at all.
    //   - Re-open without closing. The consumer's existing part never ends, so
    //     it streams forever.
    //   - Emit no delta, and keep the live view on the content it already has.
    //
    // So: swap the baseline so later appends extend the update's content, and
    // let a terminal status still close the group rather than leaving the part
    // open. The wire itself is whole, because an update replaces the message
    // data, so a fresh decode — history, or a re-merge with a new decoder —
    // yields the full content.
    const priorLength = tracker.accumulated.length;
    tracker.accumulated = data;
    // Merge rather than replace: the identity keys (the group kind, the stream
    // id) are what the build hooks dispatch on, so an update that omits a tier
    // must not erase them.
    tracker.codecHeaders = { ...tracker.codecHeaders, ...codec };
    tracker.transportHeaders = { ...tracker.transportHeaders, ...transport };

    this._logger?.warn(
      'DefaultDecoderCore._decodeUpdate(); non-prefix replacement, baseline swapped, no delta emitted',
      {
        serial,
        streamId: tracker.streamId,
        priorLength,
        replacementLength: data.length,
      },
    );

    const outputs: TEvent[] = [];
    this._applyTerminalStatus(tracker, status, tracker.codecHeaders, outputs);

    return outputs;
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
    const newTracker: StreamSequenceState = {
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
 * @param logger - Logger for diagnostic output.
 * @returns A new {@link DecoderCore} instance.
 */
export const createDecoderCore = <TEvent>(hooks: DecoderCoreHooks<TEvent>, logger?: Logger): DecoderCore<TEvent> =>
  new DefaultDecoderCore(hooks, logger);
