/**
 * Vercel AI SDK Decoder
 *
 * Maps Ably inbound messages to DecoderOutput<UIMessageChunk, UIMessage>[].
 *
 * Delegates action dispatch and serial tracking to the decoder core.
 * This file contains only the Vercel-specific event building, discrete
 * event decoding, and synthetic event emission.
 *
 * Domain-specific headers use the `x-domain-` prefix. Transport-level
 * headers use the `x-ably-` prefix.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

import { HEADER_ROLE, HEADER_TURN_ID } from '../../constants.js';
import type { DecoderCore, DecoderCoreHooks, DecoderCoreOptions } from '../../core/codec/decoder.js';
import { createDecoderCore, eventOutput } from '../../core/codec/decoder.js';
import type { LifecycleTracker } from '../../core/codec/lifecycle-tracker.js';
import { createLifecycleTracker } from '../../core/codec/lifecycle-tracker.js';
import type { DecoderOutput, MessagePayload, StreamDecoder, StreamTrackerState } from '../../core/codec/types.js';
import { type DomainHeaderReader, headerReader as rawHeaderReader, stripUndefined } from '../../utils.js';

// ---------------------------------------------------------------------------
// Vercel-specific header reader (casts providerMetadata to AI.ProviderMetadata)
// ---------------------------------------------------------------------------

interface VercelHeaderReader extends DomainHeaderReader {
  /** Read the `providerMetadata` domain header, cast to the AI SDK type. */
  providerMetadata(): AI.ProviderMetadata | undefined;
}

/**
 * Create a header reader that adds Vercel-specific `providerMetadata` typing.
 * @param headers - The raw headers record to read domain headers from.
 * @returns A typed accessor with Vercel-specific providerMetadata typing.
 */
const headerReader = (headers: Record<string, string>): VercelHeaderReader => {
  const base = rawHeaderReader(headers);
  return {
    ...base,
    // CAST: Trust boundary — the encoder serialized a valid ProviderMetadata value.
    providerMetadata: () => base.json('providerMetadata') as AI.ProviderMetadata | undefined,
  };
};

// ---------------------------------------------------------------------------
// Wire format types (trust boundaries for JSON-parsed data)
// ---------------------------------------------------------------------------

/** Wire format for tool-input-error data payload. */
interface ToolInputErrorWireData {
  errorText?: string;
  input?: unknown;
}

/** Wire format for tool-output-available data payload. */
interface ToolOutputAvailableWireData {
  output?: unknown;
}

/** Wire format for tool-output-error data payload. */
interface ToolOutputErrorWireData {
  errorText?: string;
}

// ---------------------------------------------------------------------------
// Shared output type alias
// ---------------------------------------------------------------------------

type Out = DecoderOutput<AI.UIMessageChunk, AI.UIMessage>;

/**
 * Bind eventOutput to the Vercel domain types.
 * @param chunk - The UIMessageChunk to wrap.
 * @returns A single-element decoder output array.
 */
const event = (chunk: AI.UIMessageChunk): Out[] => eventOutput<AI.UIMessageChunk, AI.UIMessage>(chunk);

// ---------------------------------------------------------------------------
// JSON boundary helpers
// ---------------------------------------------------------------------------

/**
 * Validate a finish reason string against the FinishReason union.
 * @param value - The finish reason string from the wire, or undefined.
 * @param fallback - Default finish reason if the value is not recognized.
 * @returns The validated FinishReason.
 */
const parseFinishReason = (value: string | undefined, fallback: AI.FinishReason): AI.FinishReason => {
  if (
    value === 'stop' ||
    value === 'length' ||
    value === 'content-filter' ||
    value === 'tool-calls' ||
    value === 'error' ||
    value === 'other'
  ) {
    return value;
  }
  return fallback;
};

/**
 * Type predicate for data-* message names.
 * @param name - The message name to check.
 * @returns True if the name starts with "data-".
 */
const isDataEventName = (name: string): name is `data-${string}` => name.startsWith('data-');

/**
 * Parse a string as JSON, returning the raw string if parsing fails
 * or undefined if empty.
 * @param value - The string to attempt JSON parsing on.
 * @returns The parsed value, the raw string on parse failure, or undefined if empty.
 */
const parseJsonOrString = (value: string): unknown => {
  if (!value) return undefined;
  try {
    // CAST: JSON.parse returns any; unknown is the safe trust-boundary type.
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

// ---------------------------------------------------------------------------
// Streamed message event builders
// ---------------------------------------------------------------------------

const buildStartChunk = (tracker: StreamTrackerState): AI.UIMessageChunk => {
  const r = headerReader(tracker.headers);
  switch (tracker.name) {
    case 'text': {
      return stripUndefined({
        type: 'text-start' as const,
        id: tracker.streamId,
        providerMetadata: r.providerMetadata(),
      });
    }
    case 'reasoning': {
      return stripUndefined({
        type: 'reasoning-start' as const,
        id: tracker.streamId,
        providerMetadata: r.providerMetadata(),
      });
    }
    case 'tool-input': {
      return stripUndefined({
        type: 'tool-input-start' as const,
        toolCallId: tracker.streamId,
        toolName: r.strOr('toolName', ''),
        dynamic: r.bool('dynamic'),
        title: r.str('title'),
        providerExecuted: r.bool('providerExecuted'),
        providerMetadata: r.providerMetadata(),
      });
    }
    default: {
      return { type: 'text-start', id: tracker.streamId };
    }
  }
};

const buildDeltaChunk = (tracker: StreamTrackerState, delta: string): AI.UIMessageChunk => {
  switch (tracker.name) {
    case 'text': {
      return { type: 'text-delta', id: tracker.streamId, delta };
    }
    case 'reasoning': {
      return { type: 'reasoning-delta', id: tracker.streamId, delta };
    }
    case 'tool-input': {
      return { type: 'tool-input-delta', toolCallId: tracker.streamId, inputTextDelta: delta };
    }
    default: {
      return { type: 'text-delta', id: tracker.streamId, delta };
    }
  }
};

const buildEndChunk = (tracker: StreamTrackerState, closingHeaders: Record<string, string>): AI.UIMessageChunk => {
  const r = headerReader(closingHeaders);
  switch (tracker.name) {
    case 'text': {
      return stripUndefined({
        type: 'text-end' as const,
        id: tracker.streamId,
        providerMetadata: r.providerMetadata(),
      });
    }
    case 'reasoning': {
      return stripUndefined({
        type: 'reasoning-end' as const,
        id: tracker.streamId,
        providerMetadata: r.providerMetadata(),
      });
    }
    case 'tool-input': {
      return stripUndefined({
        type: 'tool-input-available' as const,
        toolCallId: tracker.streamId,
        toolName: r.strOr('toolName', headerReader(tracker.headers).strOr('toolName', '')),
        input: parseJsonOrString(tracker.accumulated),
        providerMetadata: r.providerMetadata(),
      });
    }
    default: {
      return { type: 'text-end', id: tracker.streamId };
    }
  }
};

// ---------------------------------------------------------------------------
// Lifecycle tracker configuration (synthetic event phases)
// ---------------------------------------------------------------------------

const createVercelLifecycleTracker = (): LifecycleTracker<AI.UIMessageChunk> =>
  createLifecycleTracker<AI.UIMessageChunk>([
    {
      key: 'start',
      build: (ctx) => [stripUndefined({ type: 'start' as const, messageId: ctx.messageId })],
    },
    {
      key: 'start-step',
      build: () => [{ type: 'start-step' as const }],
    },
  ]);

/**
 * Run the lifecycle tracker and wrap results as DecoderOutput events.
 * @param lifecycle - The lifecycle tracker instance.
 * @param turnId - The turn scope ID.
 * @param context - Context passed through to phase build functions.
 * @returns Decoder outputs for any synthesized lifecycle events.
 */
const ensurePhases = (
  lifecycle: LifecycleTracker<AI.UIMessageChunk>,
  turnId: string,
  context: Record<string, string | undefined>,
): Out[] => lifecycle.ensurePhases(turnId, context).map((e) => ({ kind: 'event', event: e }));

// ---------------------------------------------------------------------------
// Discrete event decoders (one function per event type)
// ---------------------------------------------------------------------------

const decodeStart = (r: VercelHeaderReader, turnId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): Out[] => {
  lifecycle.markEmitted(turnId, 'start');
  return event(
    stripUndefined({
      type: 'start' as const,
      messageId: r.str('messageId'),
      messageMetadata: r.json('messageMetadata'),
    }),
  );
};

const decodeStartStep = (turnId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): Out[] => {
  lifecycle.markEmitted(turnId, 'start-step');
  return event({ type: 'start-step' });
};

const decodeFinishStep = (turnId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): Out[] => {
  lifecycle.resetPhase(turnId, 'start-step');
  return event({ type: 'finish-step' });
};

const decodeFinish = (r: VercelHeaderReader, turnId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): Out[] => {
  lifecycle.clearScope(turnId);
  return event(
    stripUndefined({
      type: 'finish' as const,
      finishReason: parseFinishReason(r.str('finishReason'), 'stop'),
      messageMetadata: r.json('messageMetadata'),
    }),
  );
};

const decodeError = (data: unknown): Out[] => {
  const errorText = typeof data === 'string' ? data : '';
  return event({ type: 'error', errorText });
};

const decodeAbort = (data: unknown, turnId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): Out[] => {
  lifecycle.clearScope(turnId);
  const reason = typeof data === 'string' && data ? data : undefined;
  return event(stripUndefined({ type: 'abort' as const, reason }));
};

const decodeMessageMetadata = (r: VercelHeaderReader): Out[] =>
  event({ type: 'message-metadata', messageMetadata: r.json('messageMetadata') });

const decodeFile = (r: VercelHeaderReader, data: unknown): Out[] =>
  event(
    stripUndefined({
      type: 'file' as const,
      url: typeof data === 'string' ? data : '',
      mediaType: r.strOr('mediaType', ''),
      providerMetadata: r.providerMetadata(),
    }),
  );

const decodeSourceUrl = (r: VercelHeaderReader, data: unknown): Out[] =>
  event(
    stripUndefined({
      type: 'source-url' as const,
      sourceId: r.strOr('sourceId', ''),
      url: typeof data === 'string' ? data : '',
      title: r.str('title'),
      providerMetadata: r.providerMetadata(),
    }),
  );

const decodeSourceDocument = (r: VercelHeaderReader): Out[] =>
  event(
    stripUndefined({
      type: 'source-document' as const,
      sourceId: r.strOr('sourceId', ''),
      mediaType: r.strOr('mediaType', ''),
      title: r.strOr('title', ''),
      filename: r.str('filename'),
      providerMetadata: r.providerMetadata(),
    }),
  );

const decodeToolInputError = (r: VercelHeaderReader, data: unknown): Out[] => {
  // CAST: Trust boundary — encoder produced the expected object shape.
  const parsed = data as ToolInputErrorWireData | undefined;
  return event(
    stripUndefined({
      type: 'tool-input-error' as const,
      toolCallId: r.strOr('toolCallId', ''),
      toolName: r.strOr('toolName', ''),
      errorText: parsed?.errorText ?? '',
      input: parsed?.input,
      dynamic: r.bool('dynamic'),
      title: r.str('title'),
      providerExecuted: r.bool('providerExecuted'),
      providerMetadata: r.providerMetadata(),
    }),
  );
};

const decodeToolOutputAvailable = (r: VercelHeaderReader, data: unknown): Out[] => {
  // CAST: Trust boundary — encoder produced the expected object shape.
  const parsed = data as ToolOutputAvailableWireData | undefined;
  return event(
    stripUndefined({
      type: 'tool-output-available' as const,
      toolCallId: r.strOr('toolCallId', ''),
      output: parsed?.output,
      dynamic: r.bool('dynamic'),
      providerExecuted: r.bool('providerExecuted'),
      preliminary: r.bool('preliminary'),
    }),
  );
};

const decodeToolOutputError = (r: VercelHeaderReader, data: unknown): Out[] => {
  // CAST: Trust boundary — encoder produced the expected object shape.
  const parsed = data as ToolOutputErrorWireData | undefined;
  return event(
    stripUndefined({
      type: 'tool-output-error' as const,
      toolCallId: r.strOr('toolCallId', ''),
      errorText: parsed?.errorText ?? '',
      dynamic: r.bool('dynamic'),
      providerExecuted: r.bool('providerExecuted'),
    }),
  );
};

const decodeToolApprovalRequest = (r: VercelHeaderReader): Out[] =>
  event({
    type: 'tool-approval-request',
    toolCallId: r.strOr('toolCallId', ''),
    approvalId: r.strOr('approvalId', ''),
  });

const decodeToolOutputDenied = (r: VercelHeaderReader): Out[] =>
  event({ type: 'tool-output-denied', toolCallId: r.strOr('toolCallId', '') });

const decodeDataEvent = (name: `data-${string}`, r: VercelHeaderReader, data: unknown): Out[] =>
  event(
    stripUndefined({
      type: name,
      data,
      id: r.str('id'),
      transient: r.bool('transient'),
    }),
  );

// ---------------------------------------------------------------------------
// Non-streaming tool-input helper
// ---------------------------------------------------------------------------

const decodeNonStreamingToolInput = (
  r: VercelHeaderReader,
  data: unknown,
  turnId: string,
  lifecycle: LifecycleTracker<AI.UIMessageChunk>,
): Out[] => {
  const outputs = ensurePhases(lifecycle, turnId, { messageId: r.str('messageId') });

  outputs.push(
    {
      kind: 'event',
      event: stripUndefined({
        type: 'tool-input-start' as const,
        toolCallId: r.strOr('toolCallId', ''),
        toolName: r.strOr('toolName', ''),
        dynamic: r.bool('dynamic'),
        title: r.str('title'),
        providerExecuted: r.bool('providerExecuted'),
        providerMetadata: r.providerMetadata(),
      }),
    },
    {
      kind: 'event',
      event: stripUndefined({
        type: 'tool-input-available' as const,
        toolCallId: r.strOr('toolCallId', ''),
        toolName: r.strOr('toolName', ''),
        input: data,
        providerMetadata: r.providerMetadata(),
      }),
    },
  );

  return outputs;
};

// ---------------------------------------------------------------------------
// Discrete event dispatch
// ---------------------------------------------------------------------------

/**
 * Reconstruct a UIMessage from a discrete message part published by writeMessage.
 * The encoder splits each UIMessage into per-part Ably messages with a shared
 * x-domain-messageId. This function rebuilds a single-part UIMessage from one
 * such Ably message. The transport's tree upsert merges parts that share the
 * same x-ably-msg-id, so multi-part messages accumulate correctly over
 * successive decoder calls.
 * @param input - The discrete message payload to decode.
 * @returns A single-element array with the reconstructed UIMessage, or empty if unrecognized.
 */
const decodeDiscreteMessage = (input: MessagePayload): Out[] => {
  const h = input.headers ?? {};
  const r = headerReader(h);
  const role = (h[HEADER_ROLE] ?? 'user') as AI.UIMessage['role'];
  const messageId = r.str('messageId') ?? '';

  let part: AI.UIMessage['parts'][number] | undefined;

  switch (input.name) {
    case 'text': {
      part = { type: 'text', text: typeof input.data === 'string' ? input.data : '' };
      break;
    }
    case 'file': {
      part = {
        type: 'file',
        mediaType: r.strOr('mediaType', ''),
        url: typeof input.data === 'string' ? input.data : '',
      };
      break;
    }
    default: {
      if (isDataEventName(input.name)) {
        // CAST: data-* part type matches the DataUIPart shape.
        part = stripUndefined({ type: input.name, id: r.str('id'), data: input.data }) as AI.UIMessage['parts'][number];
      }
      break;
    }
  }

  if (!part) return [];

  const message: AI.UIMessage = { id: messageId, role, parts: [part] };
  return [{ kind: 'message', message }];
};

/**
 * Whether a message name represents a discrete message part (written by writeMessage)
 * rather than a streaming lifecycle event. Discrete message parts carry x-ably-role
 * and encode a single UIMessage part each.
 * @param name - The Ably message name to check.
 * @param headers - The Ably message headers to inspect for role presence.
 * @returns True if this is a discrete message part, false if it's a lifecycle event.
 */
const isDiscreteMessagePart = (name: string, headers: Record<string, string>): boolean =>
  (name === 'text' || name === 'file' || isDataEventName(name)) && HEADER_ROLE in headers;

const decodeDiscretePayload = (input: MessagePayload, lifecycle: LifecycleTracker<AI.UIMessageChunk>): Out[] => {
  const h = input.headers ?? {};
  const r = headerReader(h);
  const turnId = h[HEADER_TURN_ID] ?? '';

  // Discrete message parts from writeMessage (user messages, history entries).
  // Distinguished from lifecycle events by the presence of x-ably-role.
  if (isDiscreteMessagePart(input.name, h)) {
    return decodeDiscreteMessage(input);
  }

  if (input.name === 'tool-input') {
    return decodeNonStreamingToolInput(r, input.data, turnId, lifecycle);
  }

  switch (input.name) {
    case 'start': {
      return decodeStart(r, turnId, lifecycle);
    }
    case 'start-step': {
      return decodeStartStep(turnId, lifecycle);
    }
    case 'finish-step': {
      return decodeFinishStep(turnId, lifecycle);
    }
    case 'finish': {
      return decodeFinish(r, turnId, lifecycle);
    }
    case 'error': {
      return decodeError(input.data);
    }
    case 'abort': {
      return decodeAbort(input.data, turnId, lifecycle);
    }
    case 'message-metadata': {
      return decodeMessageMetadata(r);
    }
    case 'file': {
      return decodeFile(r, input.data);
    }
    case 'source-url': {
      return decodeSourceUrl(r, input.data);
    }
    case 'source-document': {
      return decodeSourceDocument(r);
    }
    case 'tool-input-error': {
      return decodeToolInputError(r, input.data);
    }
    case 'tool-output-available': {
      return decodeToolOutputAvailable(r, input.data);
    }
    case 'tool-output-error': {
      return decodeToolOutputError(r, input.data);
    }
    case 'tool-approval-request': {
      return decodeToolApprovalRequest(r);
    }
    case 'tool-output-denied': {
      return decodeToolOutputDenied(r);
    }
    default: {
      return isDataEventName(input.name) ? decodeDataEvent(input.name, r, input.data) : [];
    }
  }
};

// ---------------------------------------------------------------------------
// Decoder core hooks
// ---------------------------------------------------------------------------

const createHooks = (
  lifecycle: LifecycleTracker<AI.UIMessageChunk>,
): DecoderCoreHooks<AI.UIMessageChunk, AI.UIMessage> => ({
  buildStartEvents: (tracker: StreamTrackerState): Out[] => {
    const turnId = tracker.headers[HEADER_TURN_ID] ?? '';
    const messageId = headerReader(tracker.headers).str('messageId');
    const outputs = ensurePhases(lifecycle, turnId, { messageId });
    outputs.push({ kind: 'event', event: buildStartChunk(tracker) });
    return outputs;
  },

  buildDeltaEvents: (tracker: StreamTrackerState, delta: string): Out[] => event(buildDeltaChunk(tracker, delta)),

  buildEndEvents: (tracker: StreamTrackerState, closingHeaders: Record<string, string>): Out[] =>
    event(buildEndChunk(tracker, closingHeaders)),

  decodeDiscrete: (payload: MessagePayload): Out[] => decodeDiscretePayload(payload, lifecycle),
});

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultUIMessageDecoder implements StreamDecoder<AI.UIMessageChunk, AI.UIMessage> {
  private readonly _core: DecoderCore<AI.UIMessageChunk, AI.UIMessage>;

  constructor(options: DecoderCoreOptions = {}) {
    this._core = createDecoderCore<AI.UIMessageChunk, AI.UIMessage>(
      createHooks(createVercelLifecycleTracker()),
      options,
    );
  }

  decode(message: Ably.InboundMessage): Out[] {
    return this._core.decode(message);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel AI SDK decoder that maps Ably messages to UIMessageChunk
 * events and UIMessage objects via the decoder core.
 * @param options - Decoder configuration (callbacks, logger).
 * @returns A {@link StreamDecoder} for UIMessageChunk/UIMessage.
 */
export const createDecoder = (options: DecoderCoreOptions = {}): StreamDecoder<AI.UIMessageChunk, AI.UIMessage> =>
  new DefaultUIMessageDecoder(options);
