/**
 * Anthropic Agent SDK Decoder
 *
 * Maps Ably inbound messages to DecoderOutput<AgentCodecEvent, AgentMessage>[].
 *
 * Delegates action dispatch and serial tracking to the decoder core.
 * This file contains only the Anthropic-specific event building, discrete
 * event decoding, and synthetic event emission.
 *
 * Domain-specific headers use the `x-domain-` prefix. Transport-level
 * headers use the `x-ably-` prefix.
 */

import type { UUID } from 'node:crypto';

import type * as Anthropic from '@anthropic-ai/claude-agent-sdk';
import type * as Ably from 'ably';

import { HEADER_TURN_ID } from '../../constants.js';
import type { DecoderCore, DecoderCoreHooks, DecoderCoreOptions } from '../../core/codec/decoder.js';
import { createDecoderCore, eventOutput } from '../../core/codec/decoder.js';
import type { LifecycleTracker } from '../../core/codec/lifecycle-tracker.js';
import { createLifecycleTracker } from '../../core/codec/lifecycle-tracker.js';
import type { DecoderOutput, MessagePayload, StreamDecoder, StreamTrackerState } from '../../core/codec/types.js';
import { headerReader } from '../../utils.js';
import type { AgentCodecEvent, AgentMessage, BetaMessage, StreamEvent } from './types.js';

// ---------------------------------------------------------------------------
// Shared output type alias
// ---------------------------------------------------------------------------

type Out = DecoderOutput<AgentCodecEvent, AgentMessage>;

/**
 * Bind eventOutput to the Anthropic domain types.
 * @param e - The AgentCodecEvent to wrap.
 * @returns A single-element decoder output array.
 */
const event = (e: AgentCodecEvent): Out[] => eventOutput<AgentCodecEvent, AgentMessage>(e);

// ---------------------------------------------------------------------------
// SDKPartialAssistantMessage construction helper
// ---------------------------------------------------------------------------

/**
 * Wrap a BetaRawMessageStreamEvent in an SDKPartialAssistantMessage envelope.
 * @param streamEvent - The inner stream event to wrap.
 * @param headers - Domain headers for reading parentToolUseId and messageId.
 * @returns A fully formed SDKPartialAssistantMessage.
 */
const wrapStreamEvent = (
  streamEvent: StreamEvent,
  headers: Record<string, string>,
): Anthropic.SDKPartialAssistantMessage => ({
  type: 'stream_event',
  event: streamEvent,
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  parent_tool_use_id: headerReader(headers).str('parentToolUseId') ?? null,
  // CAST: UUID from domain header. Synthetic events use a placeholder.
  uuid: (headerReader(headers).str('messageId') ?? 'synthetic') as UUID,
  session_id: '',
});

// ---------------------------------------------------------------------------
// Lifecycle tracker configuration (synthetic event phases)
// ---------------------------------------------------------------------------

const createAgentLifecycleTracker = (): LifecycleTracker<AgentCodecEvent> =>
  createLifecycleTracker<AgentCodecEvent>([
    {
      key: 'message_start',
      build: (ctx) => {
        // CAST: Synthetic BetaMessage — cast through unknown because the SDK type
        // has many required fields irrelevant for this shell. The accumulator fills
        // in real data as streaming events arrive.
        /* eslint-disable unicorn/no-null -- SDK types use null for absent optional fields */
        const syntheticMessage = {
          id: ctx.messageId ?? 'synthetic',
          type: 'message',
          role: 'assistant',
          model: ctx.model ?? 'unknown',
          content: [],
          container: null,
          context_management: null,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as unknown as BetaMessage;
        /* eslint-enable unicorn/no-null */

        const syntheticEvent = {
          type: 'message_start' as const,
          message: syntheticMessage,
        } as StreamEvent;

        return [
          wrapStreamEvent(syntheticEvent, {
            'x-domain-messageId': ctx.messageId ?? 'synthetic',
            'x-domain-model': ctx.model ?? 'unknown',
          }),
        ];
      },
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
  lifecycle: LifecycleTracker<AgentCodecEvent>,
  turnId: string,
  context: Record<string, string | undefined>,
): Out[] => lifecycle.ensurePhases(turnId, context).map((e) => ({ kind: 'event', event: e }));

// ---------------------------------------------------------------------------
// Streamed message event builders
// ---------------------------------------------------------------------------

const buildStartEvents = (tracker: StreamTrackerState): AgentCodecEvent[] => {
  const r = headerReader(tracker.headers);
  const blockIndex = Number(r.strOr('blockIndex', '0'));

  switch (tracker.name) {
    case 'text': {
      return [
        wrapStreamEvent(
          {
            type: 'content_block_start',
            index: blockIndex,
            // eslint-disable-next-line unicorn/no-null -- SDK type requires null
            content_block: { type: 'text', text: '', citations: null },
          } as StreamEvent,
          tracker.headers,
        ),
      ];
    }

    case 'tool-input': {
      return [
        wrapStreamEvent(
          {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: r.strOr('toolUseId', ''),
              name: r.strOr('toolName', ''),
              input: {},
            },
          } as StreamEvent,
          tracker.headers,
        ),
      ];
    }

    case 'thinking': {
      return [
        wrapStreamEvent(
          {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          } as StreamEvent,
          tracker.headers,
        ),
      ];
    }

    default: {
      return [
        wrapStreamEvent(
          {
            type: 'content_block_start',
            index: blockIndex,
            // eslint-disable-next-line unicorn/no-null -- SDK type requires null
            content_block: { type: 'text', text: '', citations: null },
          } as StreamEvent,
          tracker.headers,
        ),
      ];
    }
  }
};

const buildDeltaEvent = (tracker: StreamTrackerState, delta: string): AgentCodecEvent => {
  const r = headerReader(tracker.headers);
  const blockIndex = Number(r.strOr('blockIndex', '0'));

  switch (tracker.name) {
    case 'text': {
      return wrapStreamEvent(
        {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: delta },
        } as StreamEvent,
        tracker.headers,
      );
    }

    case 'tool-input': {
      return wrapStreamEvent(
        {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: delta },
        } as StreamEvent,
        tracker.headers,
      );
    }

    case 'thinking': {
      return wrapStreamEvent(
        {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking: delta },
        } as StreamEvent,
        tracker.headers,
      );
    }

    default: {
      return wrapStreamEvent(
        {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: delta },
        } as StreamEvent,
        tracker.headers,
      );
    }
  }
};

const buildCloseEvents = (tracker: StreamTrackerState, closingHeaders: Record<string, string>): AgentCodecEvent[] => {
  const r = headerReader(closingHeaders);
  const blockIndex = Number(r.strOr('blockIndex', headerReader(tracker.headers).strOr('blockIndex', '0')));

  const events: AgentCodecEvent[] = [];

  // The encoder buffers signature_delta data and includes the accumulated
  // signature as a closing header. Emit a synthetic signature_delta before
  // content_block_stop so the accumulator can populate block.signature
  // (required for multi-turn API continuity with thinking blocks).
  const signature = r.str('signature');
  if (signature && tracker.name === 'thinking') {
    events.push(
      wrapStreamEvent(
        {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'signature_delta', signature },
        } as StreamEvent,
        closingHeaders,
      ),
    );
  }

  events.push(
    wrapStreamEvent(
      {
        type: 'content_block_stop',
        index: blockIndex,
      } as StreamEvent,
      closingHeaders,
    ),
  );

  return events;
};

// ---------------------------------------------------------------------------
// Discrete event decoders (one function per event type)
// ---------------------------------------------------------------------------

const decodeMessageStart = (
  input: MessagePayload,
  turnId: string,
  lifecycle: LifecycleTracker<AgentCodecEvent>,
): Out[] => {
  lifecycle.markEmitted(turnId, 'message_start');
  const h = input.headers ?? {};
  return event(
    wrapStreamEvent(
      {
        type: 'message_start',
        // CAST: Trust boundary — encoder serialized a BetaMessage from the wire.
        message: input.data as BetaMessage,
      } as StreamEvent,
      h,
    ),
  );
};

const decodeMessageDelta = (input: MessagePayload): Out[] => {
  const h = input.headers ?? {};
  // CAST: Trust boundary — encoder serialized { stop_reason, usage } as the data payload.
  // Split into the delta (stop_reason) and usage fields that message_delta expects.
  const wireData = (input.data ?? {}) as Record<string, unknown>;
  return event(
    wrapStreamEvent(
      {
        type: 'message_delta',
        delta: { stop_reason: wireData.stop_reason },
        usage: wireData.usage ?? { output_tokens: 0 },
      } as StreamEvent,
      h,
    ),
  );
};

const decodeMessageStop = (input: MessagePayload): Out[] => {
  const h = input.headers ?? {};
  return event(wrapStreamEvent({ type: 'message_stop' } as StreamEvent, h));
};

const decodeAssistantMessage = (input: MessagePayload): Out[] => {
  const h = input.headers ?? {};
  const r = headerReader(h);
  // CAST: Trust boundary — encoder serialized an SDKAssistantMessage.

  const message: Anthropic.SDKAssistantMessage = {
    type: 'assistant',
    message: input.data as Anthropic.SDKAssistantMessage['message'],
    // eslint-disable-next-line unicorn/no-null -- SDK type requires null
    parent_tool_use_id: r.str('parentToolUseId') ?? null,
    // CAST: UUID from domain header. The encoder writes both the BetaMessage.id
    // (as 'messageId') and the Agent SDK uuid (as 'uuid').
    uuid: (r.str('uuid') ?? r.str('messageId') ?? '') as UUID,
    session_id: r.str('sessionId') ?? '',
  };
  return [{ kind: 'message', message }];
};

const decodeUserMessage = (input: MessagePayload): Out[] => {
  const h = input.headers ?? {};
  const r = headerReader(h);
  // CAST: Trust boundary — encoder serialized an SDKUserMessage.

  // SDKUserMessage.uuid is optional — only set it if the encoder wrote one.
  const uuidValue = r.str('uuid');

  const message: Anthropic.SDKUserMessage = {
    type: 'user',
    message: input.data as Anthropic.SDKUserMessage['message'],
    // eslint-disable-next-line unicorn/no-null -- SDK type requires null
    parent_tool_use_id: r.str('parentToolUseId') ?? null,
    isSynthetic: r.bool('isSynthetic'),
    ...(uuidValue ? { uuid: uuidValue as UUID } : {}),
    session_id: r.str('sessionId') ?? '',
  };
  return [{ kind: 'message', message }];
};

const decodeResult = (input: MessagePayload, turnId: string, lifecycle: LifecycleTracker<AgentCodecEvent>): Out[] => {
  lifecycle.clearScope(turnId);
  // CAST: Trust boundary — encoder serialized the full SDKResultMessage.
  const result = input.data as Anthropic.SDKResultMessage;
  return event(result);
};

const decodeToolProgress = (input: MessagePayload): Out[] => {
  // CAST: Trust boundary — encoder serialized the full SDKToolProgressMessage.
  const progress = input.data as Anthropic.SDKToolProgressMessage;
  return event(progress);
};

const decodeAbort = (input: MessagePayload, turnId: string, lifecycle: LifecycleTracker<AgentCodecEvent>): Out[] => {
  lifecycle.clearScope(turnId);
  // CAST: Construct a minimal SDKResultMessage to signal the stream ended.
  // Synthetic transport signal with placeholder fields — carries enough data
  // for the stream router's isTerminal check and accumulator cleanup.
  const reason = typeof input.data === 'string' && input.data ? input.data : 'cancelled';
  /* eslint-disable unicorn/no-null -- SDK types use null for absent optional fields */
  const result = {
    type: 'result' as const,
    subtype: 'error_during_execution' as const,
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: reason,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
    modelUsage: {},
    permission_denials: [],
    errors: [reason],
    uuid: '' as unknown as UUID,
    session_id: '',
  } as unknown as Anthropic.SDKResultMessage;
  /* eslint-enable unicorn/no-null */
  return event(result);
};

const decodeContentBlock = (input: MessagePayload): Out[] => {
  const h = input.headers ?? {};
  const r = headerReader(h);
  const blockIndex = Number(r.strOr('blockIndex', '0'));

  // CAST: Trust boundary — encoder serialized the content block from the wire.
  // The content_block shape is opaque at this point; cast through unknown
  // because Record<string, unknown> does not overlap with the SDK's union.
  return event(
    wrapStreamEvent(
      {
        type: 'content_block_start',
        index: blockIndex,
        content_block: input.data,
      } as unknown as StreamEvent,
      h,
    ),
  );
};

// ---------------------------------------------------------------------------
// Discrete event dispatch
// ---------------------------------------------------------------------------

const decodeDiscretePayload = (input: MessagePayload, lifecycle: LifecycleTracker<AgentCodecEvent>): Out[] => {
  const h = input.headers ?? {};
  const turnId = h[HEADER_TURN_ID] ?? '';

  switch (input.name) {
    case 'message-start': {
      return decodeMessageStart(input, turnId, lifecycle);
    }
    case 'message-delta': {
      return decodeMessageDelta(input);
    }
    case 'message-stop': {
      return decodeMessageStop(input);
    }
    case 'assistant-message': {
      return decodeAssistantMessage(input);
    }
    case 'user-message': {
      return decodeUserMessage(input);
    }
    case 'result': {
      return decodeResult(input, turnId, lifecycle);
    }
    case 'tool-progress': {
      return decodeToolProgress(input);
    }
    case 'abort': {
      return decodeAbort(input, turnId, lifecycle);
    }
    case 'content-block': {
      return decodeContentBlock(input);
    }
    default: {
      return [];
    }
  }
};

// ---------------------------------------------------------------------------
// Decoder core hooks
// ---------------------------------------------------------------------------

const createHooks = (
  lifecycle: LifecycleTracker<AgentCodecEvent>,
): DecoderCoreHooks<AgentCodecEvent, AgentMessage> => ({
  buildStartEvents: (tracker: StreamTrackerState): Out[] => {
    const turnId = tracker.headers[HEADER_TURN_ID] ?? '';
    const r = headerReader(tracker.headers);
    const outputs = ensurePhases(lifecycle, turnId, { messageId: r.str('messageId'), model: r.str('model') });
    for (const evt of buildStartEvents(tracker)) {
      outputs.push({ kind: 'event', event: evt });
    }
    return outputs;
  },

  buildDeltaEvents: (tracker: StreamTrackerState, delta: string): Out[] => event(buildDeltaEvent(tracker, delta)),

  buildEndEvents: (tracker: StreamTrackerState, closingHeaders: Record<string, string>): Out[] =>
    buildCloseEvents(tracker, closingHeaders).flatMap((e) => event(e)),

  decodeDiscrete: (payload: MessagePayload): Out[] => decodeDiscretePayload(payload, lifecycle),
});

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

class DefaultAgentDecoder implements StreamDecoder<AgentCodecEvent, AgentMessage> {
  private readonly _core: DecoderCore<AgentCodecEvent, AgentMessage>;

  constructor(options: DecoderCoreOptions = {}) {
    this._core = createDecoderCore<AgentCodecEvent, AgentMessage>(createHooks(createAgentLifecycleTracker()), options);
  }

  decode(message: Ably.InboundMessage): Out[] {
    return this._core.decode(message);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Anthropic Agent SDK decoder that maps Ably messages to
 * AgentCodecEvent events and AgentMessage objects via the decoder core.
 * @param options - Decoder configuration (callbacks, logger).
 * @returns A {@link StreamDecoder} for AgentCodecEvent/AgentMessage.
 */
export const createDecoder = (options: DecoderCoreOptions = {}): StreamDecoder<AgentCodecEvent, AgentMessage> =>
  new DefaultAgentDecoder(options);
