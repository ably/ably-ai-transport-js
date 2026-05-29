/**
 * Vercel AI SDK Decoder.
 *
 * Maps Ably inbound messages to a flat `VercelEvent[]`. Delegates action
 * dispatch and serial tracking to the decoder core. The `LifecycleTracker`
 * is an internal helper used to pre-roll missing `start` / `start-step`
 * events on mid-stream join (history compaction, rewind miss, partial
 * page); the reducer always sees a clean event stream.
 *
 * Receive-side dispatch reads the wire `name` to pick the publish side
 * (`ai-output` for agent publishes, `ai-input` for client publishes)
 * and then routes by the `x-domain-type` domain header carrying the
 * codec event type. Domain-specific headers use the `x-domain-` prefix.
 * Transport-level headers use the `x-ably-` prefix.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT, HEADER_DISCRETE, HEADER_ROLE, HEADER_RUN_ID } from '../../constants.js';
import type { DecoderCore, DecoderCoreHooks, DecoderCoreOptions } from '../../core/codec/decoder.js';
import { createDecoderCore } from '../../core/codec/decoder.js';
import type { LifecycleTracker } from '../../core/codec/lifecycle-tracker.js';
import { createLifecycleTracker } from '../../core/codec/lifecycle-tracker.js';
import type { Decoder, MessagePayload, StreamTrackerState } from '../../core/codec/types.js';
import { type DomainHeaderReader, headerReader as rawHeaderReader, stripUndefined } from '../../utils.js';
import type { UserMessageEvent, VercelEvent } from './events.js';

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
// JSON boundary helpers
// ---------------------------------------------------------------------------

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

const isDataEventName = (name: string): name is `data-${string}` => name.startsWith('data-');

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

/**
 * Read the codec event type from a tracker's persistent headers. The
 * encoder stamps `x-domain-type` on every `ai-output` publish; the value
 * carries the AI-SDK chunk family (`text` / `reasoning` / `tool-input`)
 * that the stream represents.
 * @param tracker - The stream tracker carrying the persistent headers.
 * @returns The codec event type, or the empty string when absent.
 */
const codecTypeOf = (tracker: StreamTrackerState): string => headerReader(tracker.headers).strOr('type', '');

const buildStartChunk = (tracker: StreamTrackerState): AI.UIMessageChunk => {
  const r = headerReader(tracker.headers);
  switch (codecTypeOf(tracker)) {
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
  switch (codecTypeOf(tracker)) {
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
  switch (codecTypeOf(tracker)) {
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
// Lifecycle tracker configuration (synthetic event phases on mid-stream join)
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

// ---------------------------------------------------------------------------
// Discrete event decoders
// ---------------------------------------------------------------------------

const decodeStart = (
  r: VercelHeaderReader,
  runId: string,
  lifecycle: LifecycleTracker<AI.UIMessageChunk>,
): VercelEvent[] => {
  lifecycle.markEmitted(runId, 'start');
  return [
    stripUndefined({
      type: 'start' as const,
      messageId: r.str('messageId'),
      messageMetadata: r.json('messageMetadata'),
    }),
  ];
};

const decodeStartStep = (runId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): VercelEvent[] => {
  lifecycle.markEmitted(runId, 'start-step');
  return [{ type: 'start-step' }];
};

const decodeFinishStep = (runId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): VercelEvent[] => {
  lifecycle.resetPhase(runId, 'start-step');
  return [{ type: 'finish-step' }];
};

const decodeFinish = (
  r: VercelHeaderReader,
  runId: string,
  lifecycle: LifecycleTracker<AI.UIMessageChunk>,
): VercelEvent[] => {
  lifecycle.clearScope(runId);
  return [
    stripUndefined({
      type: 'finish' as const,
      finishReason: parseFinishReason(r.str('finishReason'), 'stop'),
      messageMetadata: r.json('messageMetadata'),
    }),
  ];
};

const decodeError = (data: unknown, runId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): VercelEvent[] => {
  lifecycle.clearScope(runId);
  const errorText = typeof data === 'string' ? data : '';
  return [{ type: 'error', errorText }];
};

const decodeAbort = (data: unknown, runId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): VercelEvent[] => {
  lifecycle.clearScope(runId);
  const reason = typeof data === 'string' && data ? data : undefined;
  return [stripUndefined({ type: 'abort' as const, reason })];
};

const decodeMessageMetadata = (r: VercelHeaderReader): VercelEvent[] => [
  { type: 'message-metadata', messageMetadata: r.json('messageMetadata') },
];

const decodeFile = (r: VercelHeaderReader, data: unknown): VercelEvent[] => [
  stripUndefined({
    type: 'file' as const,
    url: typeof data === 'string' ? data : '',
    mediaType: r.strOr('mediaType', ''),
    providerMetadata: r.providerMetadata(),
  }),
];

const decodeSourceUrl = (r: VercelHeaderReader, data: unknown): VercelEvent[] => [
  stripUndefined({
    type: 'source-url' as const,
    sourceId: r.strOr('sourceId', ''),
    url: typeof data === 'string' ? data : '',
    title: r.str('title'),
    providerMetadata: r.providerMetadata(),
  }),
];

const decodeSourceDocument = (r: VercelHeaderReader): VercelEvent[] => [
  stripUndefined({
    type: 'source-document' as const,
    sourceId: r.strOr('sourceId', ''),
    mediaType: r.strOr('mediaType', ''),
    title: r.strOr('title', ''),
    filename: r.str('filename'),
    providerMetadata: r.providerMetadata(),
  }),
];

const decodeToolInputError = (r: VercelHeaderReader, data: unknown): VercelEvent[] => {
  // CAST: Trust boundary — encoder produced the expected object shape.
  const parsed = data as ToolInputErrorWireData | undefined;
  return [
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
  ];
};

const decodeToolOutputAvailable = (r: VercelHeaderReader, data: unknown): VercelEvent[] => {
  // CAST: Trust boundary — encoder produced the expected object shape.
  const parsed = data as ToolOutputAvailableWireData | undefined;
  return [
    stripUndefined({
      type: 'tool-output-available' as const,
      toolCallId: r.strOr('toolCallId', ''),
      output: parsed?.output,
      dynamic: r.bool('dynamic'),
      providerExecuted: r.bool('providerExecuted'),
      preliminary: r.bool('preliminary'),
    }),
  ];
};

const decodeToolOutputError = (r: VercelHeaderReader, data: unknown): VercelEvent[] => {
  // CAST: Trust boundary — encoder produced the expected object shape.
  const parsed = data as ToolOutputErrorWireData | undefined;
  return [
    stripUndefined({
      type: 'tool-output-error' as const,
      toolCallId: r.strOr('toolCallId', ''),
      errorText: parsed?.errorText ?? '',
      dynamic: r.bool('dynamic'),
      providerExecuted: r.bool('providerExecuted'),
    }),
  ];
};

const decodeToolApprovalRequest = (r: VercelHeaderReader): VercelEvent[] => [
  {
    type: 'tool-approval-request',
    toolCallId: r.strOr('toolCallId', ''),
    approvalId: r.strOr('approvalId', ''),
  },
];

const decodeToolOutputDenied = (r: VercelHeaderReader): VercelEvent[] => [
  { type: 'tool-output-denied', toolCallId: r.strOr('toolCallId', '') },
];

const decodeToolApprovalResponse = (r: VercelHeaderReader): VercelEvent[] => [
  stripUndefined({
    type: 'tool-approval-response' as const,
    toolCallId: r.strOr('toolCallId', ''),
    approved: r.bool('approved') ?? false,
    reason: r.str('reason'),
  }),
];

const decodeDataEvent = (name: `data-${string}`, r: VercelHeaderReader, data: unknown): VercelEvent[] => [
  stripUndefined({
    type: name,
    data,
    id: r.str('id'),
    transient: r.bool('transient'),
  }),
];

// ---------------------------------------------------------------------------
// Non-streaming tool-input helper
// ---------------------------------------------------------------------------

const decodeNonStreamingToolInput = (
  r: VercelHeaderReader,
  data: unknown,
  runId: string,
  lifecycle: LifecycleTracker<AI.UIMessageChunk>,
): VercelEvent[] => [
  ...lifecycle.ensurePhases(runId, { messageId: r.str('messageId') }),
  stripUndefined({
    type: 'tool-input-start' as const,
    toolCallId: r.strOr('toolCallId', ''),
    toolName: r.strOr('toolName', ''),
    dynamic: r.bool('dynamic'),
    title: r.str('title'),
    providerExecuted: r.bool('providerExecuted'),
    providerMetadata: r.providerMetadata(),
  }),
  stripUndefined({
    type: 'tool-input-available' as const,
    toolCallId: r.strOr('toolCallId', ''),
    toolName: r.strOr('toolName', ''),
    input: data,
    providerMetadata: r.providerMetadata(),
  }),
];

// ---------------------------------------------------------------------------
// Discrete user-message part decoding → UserMessageEvent
// ---------------------------------------------------------------------------

/**
 * Decode a single discrete message part (from the user-message multi-part
 * wire format) into a UserMessageEvent carrying a one-part UIMessage. The
 * reducer's `_foldUserMessage` merges parts that share the same codec-message-id.
 * The part's codec event type is read from `x-domain-type`.
 * @param input - The discrete message payload (name, data, headers).
 * @returns A single `ait-user-message` event, or an empty array when the part type is unrecognised.
 */
const decodeDiscreteMessagePart = (input: MessagePayload): VercelEvent[] => {
  const h = input.headers ?? {};
  const r = headerReader(h);
  const role = (h[HEADER_ROLE] ?? 'user') as AI.UIMessage['role'];
  const messageId = r.str('messageId') ?? '';
  const codecType = r.strOr('type', '');

  let part: AI.UIMessage['parts'][number] | undefined;

  switch (codecType) {
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
      if (isDataEventName(codecType)) {
        part = stripUndefined({ type: codecType, id: r.str('id'), data: input.data });
      }
      break;
    }
  }

  if (!part) return [];

  const message: AI.UIMessage = { id: messageId, role, parts: [part] };
  const userMessage: UserMessageEvent = { type: 'ait-user-message', message };
  return [userMessage];
};

const isDiscreteMessagePart = (codecType: string, headers: Record<string, string>): boolean =>
  (codecType === 'text' || codecType === 'file' || isDataEventName(codecType)) && HEADER_DISCRETE in headers;

// ---------------------------------------------------------------------------
// Discrete payload dispatch
// ---------------------------------------------------------------------------

const decodeAiOutputPayload = (
  codecType: string,
  r: VercelHeaderReader,
  data: unknown,
  runId: string,
  lifecycle: LifecycleTracker<AI.UIMessageChunk>,
): VercelEvent[] => {
  switch (codecType) {
    case 'start': {
      return decodeStart(r, runId, lifecycle);
    }
    case 'start-step': {
      return decodeStartStep(runId, lifecycle);
    }
    case 'finish-step': {
      return decodeFinishStep(runId, lifecycle);
    }
    case 'finish': {
      return decodeFinish(r, runId, lifecycle);
    }
    case 'error': {
      return decodeError(data, runId, lifecycle);
    }
    case 'abort': {
      return decodeAbort(data, runId, lifecycle);
    }
    case 'message-metadata': {
      return decodeMessageMetadata(r);
    }
    case 'file': {
      return decodeFile(r, data);
    }
    case 'source-url': {
      return decodeSourceUrl(r, data);
    }
    case 'source-document': {
      return decodeSourceDocument(r);
    }
    case 'tool-input': {
      return decodeNonStreamingToolInput(r, data, runId, lifecycle);
    }
    case 'tool-input-error': {
      return decodeToolInputError(r, data);
    }
    case 'tool-output-available': {
      return decodeToolOutputAvailable(r, data);
    }
    case 'tool-output-error': {
      return decodeToolOutputError(r, data);
    }
    case 'tool-approval-request': {
      return decodeToolApprovalRequest(r);
    }
    case 'tool-output-denied': {
      return decodeToolOutputDenied(r);
    }
    default: {
      return isDataEventName(codecType) ? decodeDataEvent(codecType, r, data) : [];
    }
  }
};

const decodeAiInputPayload = (codecType: string, input: MessagePayload, r: VercelHeaderReader): VercelEvent[] => {
  // Multi-part user-message parts (text / file / data-*) carry x-ably-discrete
  // because they ride publishDiscreteBatch; the receive-side fans them back
  // out into a UserMessageEvent.
  if (isDiscreteMessagePart(codecType, input.headers ?? {})) {
    return decodeDiscreteMessagePart(input);
  }

  switch (codecType) {
    case 'tool-approval-response': {
      return decodeToolApprovalResponse(r);
    }
    case 'ait-regenerate': {
      // Regenerate wire — carries `parent` / `forkOf` on transport headers,
      // no domain payload. The agent's prompt-lookup reads transport headers
      // directly from the inbound Ably message; no projection fold is
      // needed here.
      return [];
    }
    default: {
      return [];
    }
  }
};

const decodeDiscretePayload = (
  input: MessagePayload,
  lifecycle: LifecycleTracker<AI.UIMessageChunk>,
): VercelEvent[] => {
  const h = input.headers ?? {};
  const r = headerReader(h);
  const runId = h[HEADER_RUN_ID] ?? '';
  const codecType = r.strOr('type', '');

  if (input.name === EVENT_AI_INPUT) {
    return decodeAiInputPayload(codecType, input, r);
  }

  if (input.name === EVENT_AI_OUTPUT) {
    return decodeAiOutputPayload(codecType, r, input.data, runId, lifecycle);
  }

  return [];
};

// ---------------------------------------------------------------------------
// Decoder core hooks
// ---------------------------------------------------------------------------

const createHooks = (lifecycle: LifecycleTracker<AI.UIMessageChunk>): DecoderCoreHooks<VercelEvent> => ({
  buildStartEvents: (tracker: StreamTrackerState): VercelEvent[] => {
    const runId = tracker.headers[HEADER_RUN_ID] ?? '';
    const messageId = headerReader(tracker.headers).str('messageId');
    return [...lifecycle.ensurePhases(runId, { messageId }), buildStartChunk(tracker)];
  },

  buildDeltaEvents: (tracker: StreamTrackerState, delta: string): VercelEvent[] => [buildDeltaChunk(tracker, delta)],

  buildEndEvents: (tracker: StreamTrackerState, closingHeaders: Record<string, string>): VercelEvent[] => [
    buildEndChunk(tracker, closingHeaders),
  ],

  decodeDiscrete: (payload: MessagePayload): VercelEvent[] => decodeDiscretePayload(payload, lifecycle),
});

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultUIMessageDecoder implements Decoder<VercelEvent> {
  private readonly _core: DecoderCore<VercelEvent>;

  constructor(options: DecoderCoreOptions = {}) {
    this._core = createDecoderCore<VercelEvent>(createHooks(createVercelLifecycleTracker()), options);
  }

  decode(message: Ably.InboundMessage): VercelEvent[] {
    return this._core.decode(message);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel AI SDK decoder that maps Ably messages to VercelEvent[]
 * via the decoder core.
 * @param options - Decoder configuration (callbacks, logger).
 * @returns A {@link Decoder} for the Vercel TEvent union.
 */
export const createDecoder = (options: DecoderCoreOptions = {}): Decoder<VercelEvent> =>
  new DefaultUIMessageDecoder(options);
