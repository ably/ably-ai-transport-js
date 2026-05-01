import type * as Ably from 'ably';

import { Headers, readHeader } from '../../headers.js';
import type { Logger } from '../../logger.js';
import type { DecodedValue } from './types.js';

/**
 * Running state of a streamed message tracked by the decoder core.
 * Accumulates text across appends and tracks lifecycle (open/closed). The
 * core hands this to the codec's hooks so the codec can shape the
 * decoded values it emits without re-implementing the wire-level state
 * machine.
 */
export interface StreamTrackerState {
  /** Ably message name (`text`, `reasoning`, `tool-input`, …). */
  name: string;
  /** Stream identity (`x-ably-stream-id`). */
  streamId: string;
  /** Full text accumulated across appends so far. */
  accumulated: string;
  /** Headers captured at start; replaced on a non-prefix `message.update`. */
  headers: Record<string, string>;
  /** True once the stream has been closed (finished or aborted). */
  closed: boolean;
}

/**
 * Hooks the decoder core delegates to for codec-shaped event building.
 * The core handles wire framing (action dispatch, serial tracking,
 * accumulation) and asks the codec to project tracker state into
 * `DecodedValue<TPart, TEvent>` outputs.
 */
export interface DecoderCoreHooks<TPart, TEvent> {
  /**
   * Build decoded values when a streamed `message.create` lands. The
   * codec typically emits a `*-start` part (e.g. `text-start`).
   * @param tracker Initial tracker state for the new stream.
   * @returns Zero or more decoded values.
   */
  buildStartEvents(tracker: StreamTrackerState): DecodedValue<TPart, TEvent>[];

  /**
   * Build decoded values for a delta on an existing stream. The codec
   * typically emits a `*-delta` part carrying the supplied delta string.
   * @param tracker Updated tracker state (delta already accumulated).
   * @param delta The text delta that just arrived.
   * @returns Zero or more decoded values.
   */
  buildDeltaEvents(tracker: StreamTrackerState, delta: string): DecodedValue<TPart, TEvent>[];

  /**
   * Build decoded values when a stream's closing append lands with
   * `x-ably-status:'finished'`. Not invoked for aborted closes — receivers
   * see the partial accumulated content but no end marker, matching the
   * encoder's intent to discard the stream.
   * @param tracker Final tracker state (everything accumulated).
   * @param closingHeaders Headers from the closing append; may differ from
   *   the start when the codec stamped end-of-stream metadata.
   * @returns Zero or more decoded values.
   */
  buildEndEvents(tracker: StreamTrackerState, closingHeaders: Record<string, string>): DecodedValue<TPart, TEvent>[];

  /**
   * Decode a discrete (non-streaming) wire — a `message.create` whose
   * `x-ably-stream` header is absent or `'false'`. Used for lifecycle
   * chunks, codec events, and complete-message parts written by
   * {@link import('./encoder-core.js').EncoderCore.publishBatch}.
   * @param input Wire payload.
   * @param input.name The Ably message name.
   * @param input.data The message data — `unknown` because discrete
   *   payloads can be strings or JSON-serialised objects.
   * @param input.headers The wire's `extras.headers`.
   * @returns Zero or more decoded values.
   */
  decodeDiscrete(input: {
    /** Ably message name. */
    name: string;
    /** Message data. */
    data: unknown;
    /** Headers from `extras.headers`. */
    headers: Record<string, string>;
  }): DecodedValue<TPart, TEvent>[];
}

/** Options for constructing a {@link DecoderCore}. */
export interface DecoderCoreOptions {
  /** Optional logger inherited by the core. */
  logger?: Logger;
  /**
   * Optional callback invoked when a tracked stream is replaced via a
   * non-prefix `message.update`. The codec uses this to surface the
   * replacement as a `kind: 'event'` decoded value (deferred until a
   * concrete codec needs it). Declared as a property (not a method) so
   * the core can capture and re-invoke it without binding `this`.
   */
  readonly onStreamUpdate?: (tracker: StreamTrackerState) => void;
  /**
   * Optional callback invoked when a `message.delete` clears a tracked
   * stream. Codecs that need to surface deletion to consumers wire it
   * here. Declared as a property (not a method) so the core can capture
   * and re-invoke it without binding `this`.
   */
  readonly onStreamDelete?: (serial: string, tracker: StreamTrackerState | undefined) => void;
}

/**
 * Action-dispatching decoder primitive. Tracks streams by their server
 * -assigned serial across `message.create`/`append`/`update`/`delete`
 * actions and delegates value construction to the codec's
 * {@link DecoderCoreHooks}.
 */
export interface DecoderCore<TPart, TEvent> {
  /**
   * Decode one inbound message into zero or more codec-shaped values.
   * @param message The inbound message to decode.
   * @returns Zero or more decoded values, each tagged with the
   *   `x-ably-msg-id` from the inbound (when present).
   */
  decode(message: Ably.InboundMessage): DecodedValue<TPart, TEvent>[];
}

class DefaultDecoderCore<TPart, TEvent> implements DecoderCore<TPart, TEvent> {
  private readonly _hooks: DecoderCoreHooks<TPart, TEvent>;
  private readonly _logger: Logger | undefined;
  private readonly _onStreamUpdate: ((tracker: StreamTrackerState) => void) | undefined;
  private readonly _onStreamDelete: ((serial: string, tracker: StreamTrackerState | undefined) => void) | undefined;
  private readonly _serialState = new Map<string, StreamTrackerState>();

  constructor(hooks: DecoderCoreHooks<TPart, TEvent>, options: DecoderCoreOptions = {}) {
    this._hooks = hooks;
    this._logger = options.logger?.withContext({ component: 'DecoderCore' });
    this._onStreamUpdate = options.onStreamUpdate;
    this._onStreamDelete = options.onStreamDelete;
  }

  decode(message: Ably.InboundMessage): DecodedValue<TPart, TEvent>[] {
    const action = message.action;
    this._logger?.trace('DefaultDecoderCore.decode();', {
      action,
      serial: message.serial,
      name: message.name,
    });

    let outputs: DecodedValue<TPart, TEvent>[];
    switch (action) {
      case 'message.create': {
        outputs = this._decodeCreate(message);
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

    // Tag each output with the inbound's x-ably-msg-id so the accumulator
    // can route it to the correct in-progress message — same correlation
    // pass the OLD code did.
    const messageId = readHeader(message, Headers.MessageId);
    if (messageId === undefined) {
      return outputs;
    }
    return outputs.map((output) => ({ ...output, messageId }));
  }

  private _decodeCreate(message: Ably.InboundMessage): DecodedValue<TPart, TEvent>[] {
    const headers = getHeaders(message);
    const isStream = headers[Headers.Stream] === 'true';
    const serial = message.serial;

    if (isStream && serial !== undefined) {
      const streamId = headers[Headers.StreamId] ?? '';
      const tracker: StreamTrackerState = {
        name: message.name ?? '',
        streamId,
        accumulated: typeof message.data === 'string' ? message.data : '',
        headers: { ...headers },
        closed: false,
      };
      this._serialState.set(serial, tracker);
      this._logger?.debug('DefaultDecoderCore._decodeCreate(); new stream', {
        name: tracker.name,
        streamId,
        serial,
      });
      return this._hooks.buildStartEvents(tracker);
    }

    return this._hooks.decodeDiscrete({
      name: message.name ?? '',
      // CAST: Ably.InboundMessage.data is typed `any`; treat as unknown at the boundary.
      data: message.data as unknown,
      headers,
    });
  }

  private _decodeAppend(message: Ably.InboundMessage): DecodedValue<TPart, TEvent>[] {
    const serial = message.serial;
    if (serial === undefined) {
      return [];
    }
    const tracker = this._serialState.get(serial);
    if (!tracker) {
      // Unknown serial on append — treat as first-contact update so the
      // codec still has a chance to handle a recovery `updateMessage`.
      return this._decodeUpdate(message);
    }

    const headers = getHeaders(message);
    const delta = typeof message.data === 'string' ? message.data : '';
    const status = headers[Headers.Status];
    const outputs: DecodedValue<TPart, TEvent>[] = [];

    if (delta.length > 0) {
      tracker.accumulated += delta;
      outputs.push(...this._hooks.buildDeltaEvents(tracker, delta));
    }

    if (status === 'finished' && !tracker.closed) {
      tracker.closed = true;
      outputs.push(...this._hooks.buildEndEvents(tracker, headers));
      this._logger?.debug('DefaultDecoderCore._decodeAppend(); stream finished', { streamId: tracker.streamId });
    } else if (status === 'aborted' && !tracker.closed) {
      tracker.closed = true;
      this._logger?.debug('DefaultDecoderCore._decodeAppend(); stream aborted', { streamId: tracker.streamId });
    }

    return outputs;
  }

  private _decodeUpdate(message: Ably.InboundMessage): DecodedValue<TPart, TEvent>[] {
    const serial = message.serial;
    if (serial === undefined) {
      return [];
    }
    const headers = getHeaders(message);
    const isStream = headers[Headers.Stream] === 'true';
    const status = headers[Headers.Status];
    const data = typeof message.data === 'string' ? message.data : '';

    const tracker = this._serialState.get(serial);
    if (!tracker) {
      return this._decodeFirstContact(message, isStream, status, serial, headers, data);
    }

    if (data.startsWith(tracker.accumulated)) {
      const delta = data.slice(tracker.accumulated.length);
      const outputs: DecodedValue<TPart, TEvent>[] = [];
      if (delta.length > 0) {
        tracker.accumulated = data;
        outputs.push(...this._hooks.buildDeltaEvents(tracker, delta));
      }
      if (status === 'finished' && !tracker.closed) {
        tracker.closed = true;
        outputs.push(...this._hooks.buildEndEvents(tracker, headers));
      } else if (status === 'aborted' && !tracker.closed) {
        tracker.closed = true;
      }
      return outputs;
    }

    // Replacement (non-prefix update). Surface to the codec via the
    // optional onStreamUpdate hook; no decoded values for the default
    // decoder — codecs that care subscribe via the hook.
    tracker.accumulated = data;
    tracker.headers = { ...headers };
    if (this._onStreamUpdate) {
      try {
        this._onStreamUpdate(tracker);
      } catch (error) {
        this._logger?.error('DefaultDecoderCore._decodeUpdate(); onStreamUpdate threw', { error });
      }
    }
    return [];
  }

  private _decodeFirstContact(
    message: Ably.InboundMessage,
    isStream: boolean,
    status: string | undefined,
    serial: string,
    headers: Record<string, string>,
    data: string,
  ): DecodedValue<TPart, TEvent>[] {
    if (!isStream) {
      return this._hooks.decodeDiscrete({
        name: message.name ?? '',
        // CAST: Ably.InboundMessage.data is typed `any`; treat as unknown at the boundary.
        data: message.data as unknown,
        headers,
      });
    }

    const streamId = headers[Headers.StreamId] ?? '';
    const tracker: StreamTrackerState = {
      name: message.name ?? '',
      streamId,
      accumulated: data,
      headers: { ...headers },
      closed: status === 'finished' || status === 'aborted',
    };
    this._serialState.set(serial, tracker);

    this._logger?.debug('DefaultDecoderCore._decodeFirstContact(); first-contact stream', {
      name: tracker.name,
      streamId,
      serial,
    });

    const outputs = this._hooks.buildStartEvents(tracker);
    if (data.length > 0) {
      outputs.push(...this._hooks.buildDeltaEvents(tracker, data));
    }
    if (status === 'finished') {
      outputs.push(...this._hooks.buildEndEvents(tracker, headers));
    }
    return outputs;
  }

  private _decodeDelete(message: Ably.InboundMessage): DecodedValue<TPart, TEvent>[] {
    const serial = message.serial;
    if (serial === undefined) {
      return [];
    }
    const tracker = this._serialState.get(serial);
    if (this._onStreamDelete) {
      try {
        this._onStreamDelete(serial, tracker);
      } catch (error) {
        this._logger?.error('DefaultDecoderCore._decodeDelete(); onStreamDelete threw', { error });
      }
    }
    if (tracker) {
      tracker.accumulated = '';
      tracker.closed = true;
    }
    this._logger?.debug('DefaultDecoderCore._decodeDelete();', { serial });
    return [];
  }
}

/**
 * Create a decoder core with the given codec hooks.
 * @param hooks Codec-shaped event-building hooks; see {@link DecoderCoreHooks}.
 * @param options Optional logger and stream-update/delete callbacks.
 * @returns A new decoder core.
 */
export const createDecoderCore = <TPart, TEvent>(
  hooks: DecoderCoreHooks<TPart, TEvent>,
  options?: DecoderCoreOptions,
): DecoderCore<TPart, TEvent> => new DefaultDecoderCore(hooks, options);

/**
 * Extract `extras.headers` from an inbound message as a typed record. Ably
 * types `extras` as `any`; this helper centralises the runtime narrowing.
 * @param message The inbound message.
 * @returns The headers record, or an empty object if absent.
 */
const getHeaders = (message: Ably.InboundMessage): Record<string, string> => {
  // CAST: Ably types `extras` as `any`; runtime checks below guard access.
  const extras = message.extras as unknown;
  if (!extras || typeof extras !== 'object') return {};
  const headers = (extras as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') return {};
  // CAST: wire protocol guarantees Record<string,string> when present.
  return headers as Record<string, string>;
};
