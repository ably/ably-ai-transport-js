/**
 * Decoder core — action dispatch and serial tracking machinery.
 *
 * Handles the Ably message action patterns (create, append, update, delete)
 * and delegates to domain-specific hooks for event building and discrete
 * event decoding.
 *
 * Domain decoders call `createDecoderCore(hooks, options)` and provide hooks
 * for stream classification, event building, and discrete decoding.
 */

import type * as Ably from 'ably';

import { HEADER_MSG_ID, HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../constants.js';
import type { Logger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { DecoderOutput, MessagePayload, StreamTrackerState } from './types.js';

/**
 * Wrap a domain event as a single-element decoder output array.
 * @param event - The domain event to wrap.
 * @returns A single-element array containing the event as a decoder output.
 */
export const eventOutput = <TEvent, TMessage>(event: TEvent): DecoderOutput<TEvent, TMessage>[] => [
  { kind: 'event', event },
];

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
export interface DecoderCoreHooks<TEvent, TMessage> {
  /**
   * Build domain events emitted when a new stream starts. May return multiple
   * events (e.g. a start event and a start-step event).
   */
  buildStartEvents(tracker: StreamTrackerState): DecoderOutput<TEvent, TMessage>[];

  /** Build domain events for a text delta received on a stream. */
  buildDeltaEvents(tracker: StreamTrackerState, delta: string): DecoderOutput<TEvent, TMessage>[];

  /**
   * Build domain events emitted when a stream finishes (x-ably-status:finished).
   * Not called for aborted streams. The closing headers may differ from
   * tracker.headers if the closing append carried updated headers.
   */
  buildEndEvents(
    tracker: StreamTrackerState,
    closingHeaders: Record<string, string>,
  ): DecoderOutput<TEvent, TMessage>[];

  /**
   * Decode a discrete message (message.create where x-ably-stream is "false",
   * or a non-streamable first-contact update). Handles user messages, lifecycle
   * events, tool lifecycle, data-*, etc.
   */
  decodeDiscrete(input: MessagePayload): DecoderOutput<TEvent, TMessage>[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** The decoder core returned by {@link createDecoderCore}. */
export interface DecoderCore<TEvent, TMessage> {
  /** Decode a single Ably message into zero or more domain outputs. */
  decode(message: Ably.InboundMessage): DecoderOutput<TEvent, TMessage>[];
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CD7
class DefaultDecoderCore<TEvent, TMessage> implements DecoderCore<TEvent, TMessage> {
  private readonly _hooks: DecoderCoreHooks<TEvent, TMessage>;
  private readonly _logger: Logger | undefined;
  private readonly _onStreamUpdate: ((tracker: StreamTrackerState) => void) | undefined;
  private readonly _onStreamDelete: ((serial: string, tracker: StreamTrackerState | undefined) => void) | undefined;
  private readonly _serialState = new Map<string, StreamTrackerState>();

  constructor(hooks: DecoderCoreHooks<TEvent, TMessage>, options: DecoderCoreOptions = {}) {
    this._hooks = hooks;
    this._onStreamUpdate = options.onStreamUpdate;
    this._onStreamDelete = options.onStreamDelete;
    this._logger = options.logger?.withContext({ component: 'DecoderCore' });
  }

  decode(message: Ably.InboundMessage): DecoderOutput<TEvent, TMessage>[] {
    const action = message.action;

    this._logger?.trace('DefaultDecoderCore.decode();', { action, serial: message.serial, name: message.name });

    let outputs: DecoderOutput<TEvent, TMessage>[];

    switch (action) {
      // Spec: AIT-CD7a
      case 'message.create': {
        const payload = this._toPayload(message);

        outputs =
          payload.headers?.[HEADER_STREAM] === 'true'
            ? this._decodeStreamedCreate(payload, message.serial)
            : this._hooks.decodeDiscrete(payload);
        break;
      }

      case 'message.append': {
        outputs = this._decodeAppend(message);
        break;
      }

      case 'message.update': {
        outputs = this._decodeUpdate(message);
        break;
      }

      case 'message.delete': {
        outputs = this._decodeDelete(message);
        break;
      }

      default: {
        return [];
      }
    }

    // Tag all event outputs with the message ID from x-ably-msg-id for accumulator correlation.
    const messageId = getHeaders(message)[HEADER_MSG_ID];
    if (messageId) {
      for (const output of outputs) {
        if (output.kind === 'event') {
          output.messageId = messageId;
        }
      }
    }

    return outputs;
  }

  // -------------------------------------------------------------------------
  // Private: extract MessagePayload
  // -------------------------------------------------------------------------

  private _toPayload(message: Ably.InboundMessage): MessagePayload {
    return {
      name: message.name ?? '',
      // CAST: Ably SDK types `data` as `any`; cast to unknown is the safe boundary type.
      data: message.data as unknown,
      headers: getHeaders(message),
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
  // Private: streamed message create
  // -------------------------------------------------------------------------

  private _decodeStreamedCreate(
    payload: MessagePayload,
    serial: string | undefined,
  ): DecoderOutput<TEvent, TMessage>[] {
    if (!serial) return [];

    const streamId = payload.headers?.[HEADER_STREAM_ID] ?? '';
    const h = payload.headers ?? {};

    const tracker: StreamTrackerState = {
      name: payload.name,
      streamId,
      accumulated: '',
      headers: { ...h },
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
  private _decodeAppend(message: Ably.InboundMessage): DecoderOutput<TEvent, TMessage>[] {
    const serial = message.serial;
    if (!serial) return [];

    const tracker = this._serialState.get(serial);
    if (!tracker) {
      // Unknown serial on append — treat as first-contact update
      return this._decodeUpdate(message);
    }

    const h = getHeaders(message);
    const delta = typeof message.data === 'string' ? message.data : '';
    const status = h[HEADER_STATUS];
    const outputs: DecoderOutput<TEvent, TMessage>[] = [];

    if (delta.length > 0) {
      tracker.accumulated += delta;
      outputs.push(...this._hooks.buildDeltaEvents(tracker, delta));
    }

    if (status === 'finished' && !tracker.closed) {
      tracker.closed = true;
      outputs.push(...this._hooks.buildEndEvents(tracker, h));
      this._logger?.debug('DefaultDecoderCore._decodeAppend(); stream finished', { streamId: tracker.streamId });
    } else if (status === 'aborted' && !tracker.closed) {
      tracker.closed = true;
      this._logger?.debug('DefaultDecoderCore._decodeAppend(); stream aborted', { streamId: tracker.streamId });
    }

    return outputs;
  }

  // -------------------------------------------------------------------------
  // Private: update handling (first-contact, prefix-match, replacement)
  // -------------------------------------------------------------------------

  // Spec: AIT-CD9
  private _decodeUpdate(message: Ably.InboundMessage): DecoderOutput<TEvent, TMessage>[] {
    const serial = message.serial;
    if (!serial) return [];

    const payload = this._toPayload(message);
    const h = payload.headers ?? {};
    const isStreamed = h[HEADER_STREAM] === 'true';
    const status = h[HEADER_STATUS];

    const tracker = this._serialState.get(serial);

    if (!tracker) {
      return this._decodeFirstContact(payload, isStreamed, status, serial);
    }

    // Updates to tracked streams use string data for prefix-match accumulation
    const data = this._stringData(message);

    // --- Tracker exists: prefix-match or replacement ---
    if (data.startsWith(tracker.accumulated)) {
      const delta = data.slice(tracker.accumulated.length);
      const outputs: DecoderOutput<TEvent, TMessage>[] = [];

      if (delta.length > 0) {
        tracker.accumulated = data;
        outputs.push(...this._hooks.buildDeltaEvents(tracker, delta));
      }

      if (status === 'finished' && !tracker.closed) {
        tracker.closed = true;
        outputs.push(...this._hooks.buildEndEvents(tracker, h));
      } else if (status === 'aborted' && !tracker.closed) {
        tracker.closed = true;
      }

      return outputs;
    }

    // --- Replacement (NOT a prefix match) ---
    tracker.accumulated = data;
    tracker.headers = { ...h };

    this._invokeOnStreamUpdate(tracker);

    return [];
  }

  private _decodeFirstContact(
    payload: MessagePayload,
    isStreamed: boolean,
    status: string | undefined,
    serial: string,
  ): DecoderOutput<TEvent, TMessage>[] {
    // Non-streamed messages are discrete
    if (!isStreamed) {
      return this._hooks.decodeDiscrete(payload);
    }

    const streamId = payload.headers?.[HEADER_STREAM_ID] ?? '';
    const h = payload.headers ?? {};
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
      headers: { ...h },
      closed: status === 'finished' || status === 'aborted',
    };
    this._serialState.set(serial, newTracker);

    // Emit start + delta (if any) + end (if finished)
    const outputs = this._hooks.buildStartEvents(newTracker);

    if (data.length > 0) {
      outputs.push(...this._hooks.buildDeltaEvents(newTracker, data));
    }

    if (status === 'finished') {
      outputs.push(...this._hooks.buildEndEvents(newTracker, h));
    }

    return outputs;
  }

  // -------------------------------------------------------------------------
  // Private: delete handling
  // -------------------------------------------------------------------------

  // Spec: AIT-CD10
  private _decodeDelete(message: Ably.InboundMessage): DecoderOutput<TEvent, TMessage>[] {
    const serial = message.serial;
    if (!serial) return [];

    const tracker = this._serialState.get(serial);

    this._invokeOnStreamDelete(serial, tracker);

    if (tracker) {
      tracker.accumulated = '';
      tracker.closed = true;
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
export const createDecoderCore = <TEvent, TMessage>(
  hooks: DecoderCoreHooks<TEvent, TMessage>,
  options: DecoderCoreOptions = {},
): DecoderCore<TEvent, TMessage> => new DefaultDecoderCore(hooks, options);
