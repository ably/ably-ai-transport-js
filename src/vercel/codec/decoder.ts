/**
 * Vercel AI SDK Decoder.
 *
 * Maps Ably inbound messages to {@link DecodedMessage} — a `{ inputs,
 * outputs }` tagged result. The decoder routes by the wire `name`
 * (`ai-input` vs `ai-output`) so the SDK never has to inspect direction:
 * input-side messages produce `VercelInput` variants; output-side
 * messages produce `VercelOutput` (`UIMessageChunk`) variants.
 *
 * The `LifecycleTracker` is an internal helper used to pre-roll missing
 * `start` / `start-step` chunks on mid-stream join (history compaction,
 * rewind miss, partial page) so the reducer always sees a clean event
 * sequence for streamed output.
 *
 * Receive-side dispatch reads the wire `name` first and then routes by
 * the codec `type` header carrying the codec event type. Codec headers live
 * under `extras.ai.codec` and transport headers under `extras.ai.transport`;
 * both are read unprefixed from their respective tier.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

import {
  EVENT_AI_INPUT,
  EVENT_AI_OUTPUT,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_DISCRETE,
  HEADER_ROLE,
  HEADER_RUN_ID,
} from '../../constants.js';
import type { DecoderCore, DecoderCoreHooks, DecoderCoreOptions } from '../../core/codec/decoder.js';
import { createDecoderCore } from '../../core/codec/decoder.js';
import { createDescriptorDecoder } from '../../core/codec/descriptor-decoder.js';
import type { LifecycleTracker } from '../../core/codec/lifecycle-tracker.js';
import { createLifecycleTracker } from '../../core/codec/lifecycle-tracker.js';
import type {
  DecodedMessage,
  Decoder,
  MessagePayload,
  StreamTrackerState,
  UserMessage,
} from '../../core/codec/types.js';
import { type DomainHeaderReader, headerReader as rawHeaderReader, stripUndefined } from '../../utils.js';
import type { VercelInput, VercelOutput } from './events.js';
import { outputs } from './outputs.js';
import { isClientToolResultErrorWireData, isToolOutputAvailableWireData } from './wire-data.js';

// Decoder-internal union — the codec emits inputs and outputs through the
// same flat list from the underlying core and partitions on the way out.
type AnyEvent = VercelInput | VercelOutput;

// Generic decode driver over the output descriptors. Rebuilds output chunks
// from the wire; the lifecycle repair below wraps it.
const outputDecoder = createDescriptorDecoder(outputs);

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
// JSON boundary helpers
// ---------------------------------------------------------------------------

const isDataEventName = (name: string): name is `data-${string}` => name.startsWith('data-');

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
// Input-side decoders (ai-input → VercelInput)
// ---------------------------------------------------------------------------

/**
 * Decode a single discrete message part (from the user-message multi-part
 * wire format) into a {@link UserMessage} carrying a one-part
 * UIMessage. The reducer's `_foldUserMessage` merges parts that share
 * the same codec-message-id.
 * @param input - The discrete message payload (name, data, headers).
 * @returns A single `user-message` input, or an empty array when the part type is unrecognised.
 */
const decodeDiscreteMessagePart = (input: MessagePayload): VercelInput[] => {
  const r = headerReader(input.codecHeaders ?? {});
  const role = (input.transportHeaders?.[HEADER_ROLE] ?? 'user') as AI.UIMessage['role'];
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
  const userMessage: UserMessage<AI.UIMessage> = { kind: 'user-message', message };
  return [userMessage];
};

const isDiscreteMessagePart = (codecType: string, headers: Record<string, string>): boolean =>
  (codecType === 'text' || codecType === 'file' || isDataEventName(codecType)) && HEADER_DISCRETE in headers;

const decodeClientToolResult = (codecMessageId: string, r: VercelHeaderReader, data: unknown): VercelInput[] => {
  const parsed = isToolOutputAvailableWireData(data) ? data : undefined;
  return [
    {
      kind: 'tool-result',
      codecMessageId,
      payload: { toolCallId: r.strOr('toolCallId', ''), output: parsed?.output },
    },
  ];
};

const decodeClientToolResultError = (codecMessageId: string, r: VercelHeaderReader, data: unknown): VercelInput[] => {
  const parsed = isClientToolResultErrorWireData(data) ? data : undefined;
  return [
    {
      kind: 'tool-result-error',
      codecMessageId,
      payload: { toolCallId: r.strOr('toolCallId', ''), message: parsed?.message ?? '' },
    },
  ];
};

const decodeClientToolApprovalResponse = (codecMessageId: string, r: VercelHeaderReader): VercelInput[] => [
  {
    kind: 'tool-approval-response',
    codecMessageId,
    payload: stripUndefined({
      toolCallId: r.strOr('toolCallId', ''),
      approved: r.bool('approved') ?? false,
      reason: r.str('reason'),
    }),
  },
];

// ---------------------------------------------------------------------------
// Discrete payload dispatch
// ---------------------------------------------------------------------------

const decodeAiInputPayload = (codecType: string, input: MessagePayload, r: VercelHeaderReader): AnyEvent[] => {
  // Multi-part user-message parts (text / file / data-*) carry discrete
  // because they ride publishDiscreteBatch; the receive-side fans them back
  // out into a UserMessage.
  if (isDiscreteMessagePart(codecType, input.transportHeaders ?? {})) {
    return decodeDiscreteMessagePart(input);
  }

  const codecMessageId = input.transportHeaders?.[HEADER_CODEC_MESSAGE_ID] ?? '';

  switch (codecType) {
    case 'tool-result': {
      return decodeClientToolResult(codecMessageId, r, input.data);
    }
    case 'tool-result-error': {
      return decodeClientToolResultError(codecMessageId, r, input.data);
    }
    case 'tool-approval-response': {
      return decodeClientToolApprovalResponse(codecMessageId, r);
    }
    case 'regenerate': {
      // Wire-only signal — carries `parent` / `msg-regenerate` on transport
      // headers, no domain payload. The agent's input-event lookup reads
      // transport headers directly from the inbound Ably message; no
      // projection fold is needed here.
      return [];
    }
    default: {
      return [];
    }
  }
};

/**
 * Apply the entry-point lifecycle repair for a discrete `ai-output` message,
 * then rebuild its chunks through the descriptor decoder. The repair (mid-
 * stream-join pre-roll, phase bookkeeping) is keyed on the codec type — not the
 * produced chunk — and stays out of the descriptors.
 * @param codecType - The codec `type` header value.
 * @param input - The inbound discrete payload.
 * @param runId - The run scope for the lifecycle tracker.
 * @param lifecycle - The lifecycle tracker.
 * @returns The decoded output chunks (with any synthesized lead-in phases).
 */
const decodeOutputDiscrete = (
  codecType: string,
  input: MessagePayload,
  runId: string,
  lifecycle: LifecycleTracker<AI.UIMessageChunk>,
): AnyEvent[] => {
  const codecHeaders = input.codecHeaders ?? {};
  const transportHeaders = input.transportHeaders ?? {};
  switch (codecType) {
    case 'start':
    case 'start-step': {
      lifecycle.markEmitted(runId, codecType);
      break;
    }
    case 'finish-step': {
      lifecycle.resetPhase(runId, 'start-step');
      break;
    }
    case 'finish':
    case 'error':
    case 'abort': {
      lifecycle.clearScope(runId);
      break;
    }
    case 'tool-input': {
      // Non-streamed tool-input: pre-roll any missing start phases, then the
      // descriptor reconstructs the start + available chunk pair.
      const pre = lifecycle.ensurePhases(runId, { messageId: headerReader(codecHeaders).str('messageId') });
      return [...pre, ...outputDecoder.decodeDiscrete(codecType, codecHeaders, transportHeaders, input.data)];
    }
  }
  return outputDecoder.decodeDiscrete(codecType, codecHeaders, transportHeaders, input.data);
};

const decodeDiscretePayload = (input: MessagePayload, lifecycle: LifecycleTracker<AI.UIMessageChunk>): AnyEvent[] => {
  const r = headerReader(input.codecHeaders ?? {});
  const runId = input.transportHeaders?.[HEADER_RUN_ID] ?? '';
  const codecType = r.strOr('type', '');

  if (input.name === EVENT_AI_INPUT) {
    return decodeAiInputPayload(codecType, input, r);
  }

  if (input.name === EVENT_AI_OUTPUT) {
    return decodeOutputDiscrete(codecType, input, runId, lifecycle);
  }

  return [];
};

// ---------------------------------------------------------------------------
// Decoder core hooks
// ---------------------------------------------------------------------------

const createHooks = (lifecycle: LifecycleTracker<AI.UIMessageChunk>): DecoderCoreHooks<AnyEvent> => ({
  buildStartEvents: (tracker: StreamTrackerState): AnyEvent[] => {
    const runId = tracker.transportHeaders[HEADER_RUN_ID] ?? '';
    const messageId = headerReader(tracker.codecHeaders).str('messageId');
    return [...lifecycle.ensurePhases(runId, { messageId }), ...outputDecoder.buildStart(tracker)];
  },

  buildDeltaEvents: (tracker: StreamTrackerState, delta: string): AnyEvent[] =>
    outputDecoder.buildDelta(tracker, delta),

  buildEndEvents: (tracker: StreamTrackerState, closingHeaders: Record<string, string>): AnyEvent[] =>
    outputDecoder.buildEnd(tracker, closingHeaders),

  decodeDiscrete: (payload: MessagePayload): AnyEvent[] => decodeDiscretePayload(payload, lifecycle),
});

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

const isInput = (event: AnyEvent): event is VercelInput => 'kind' in event;

class DefaultUIMessageDecoder implements Decoder<VercelInput, VercelOutput> {
  private readonly _core: DecoderCore<AnyEvent>;

  constructor(options: DecoderCoreOptions = {}) {
    this._core = createDecoderCore<AnyEvent>(createHooks(createVercelLifecycleTracker()), options);
  }

  decode(message: Ably.InboundMessage): DecodedMessage<VercelInput, VercelOutput> {
    const events = this._core.decode(message);
    const inputs: VercelInput[] = [];
    const outputs: VercelOutput[] = [];
    for (const event of events) {
      if (isInput(event)) {
        inputs.push(event);
      } else {
        outputs.push(event);
      }
    }
    return { inputs, outputs };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel AI SDK decoder that maps Ably messages to {@link DecodedMessage}.
 * @param options - Decoder configuration (callbacks, logger).
 * @returns A {@link Decoder} typed in both directions for the Vercel codec.
 */
export const createDecoder = (options: DecoderCoreOptions = {}): Decoder<VercelInput, VercelOutput> =>
  new DefaultUIMessageDecoder(options);
