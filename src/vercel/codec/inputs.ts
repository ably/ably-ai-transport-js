/**
 * Vercel input (`ai-input`) adapter — the complete imperative `{ encode, decode }`
 * for every `VercelInput` kind, the user-message fan-out included.
 *
 * Inputs are nested (`payload`), `kind`-discriminated, never streamed, and the
 * dominant user-message variant is a 1→N fan-out over `message.parts` that the
 * reducer reassembles — so they are an imperative adapter, not a descriptor
 * table. Encode and decode build/read every wire header through the shared
 * {@link import('./fields.js')} bindings, so the two sides cannot drift.
 */

import type * as AI from 'ai';
import { isDataUIPart } from 'ai';

import { EVENT_AI_INPUT, HEADER_CODEC_MESSAGE_ID, HEADER_ROLE } from '../../constants.js';
import type {
  InputAdapter,
  InputAdapterCore,
  InputDecodeContext,
  InputEncodeContext,
} from '../../core/codec/define-codec.js';
import type { MessagePayload, UserMessage } from '../../core/codec/types.js';
import { stripUndefined } from '../../utils.js';
import type { VercelInput } from './events.js';
import { fApproved, fId, fKind, fMediaType, fMessageId, fPartType, fReason, fToolCallId } from './fields.js';
import { isClientToolResultErrorWireData, isToolOutputAvailableWireData } from './wire-data.js';

const isDataEventName = (name: string): name is `data-${string}` => name.startsWith('data-');

// ---------------------------------------------------------------------------
// Encode (VercelInput → ai-input)
// ---------------------------------------------------------------------------

/**
 * Encode a user-message as a batch of per-part discrete `ai-input` payloads.
 * The receive-side decoder fans each part back out into a one-part UIMessage,
 * which the reducer merges by codec-message-id.
 * @param message - The UIMessage to encode.
 * @returns One payload per encodable part (at least one, so the codec-message-id and role survive).
 */
const encodeMessagePayloads = (message: AI.UIMessage): MessagePayload[] => {
  const messageId = message.id;
  const payloads: MessagePayload[] = [];

  for (const part of message.parts) {
    switch (part.type) {
      case 'text': {
        const codecHeaders: Record<string, string> = {};
        fKind.write(codecHeaders, 'user-message');
        fPartType.write(codecHeaders, 'text');
        fMessageId.write(codecHeaders, messageId);
        payloads.push({ name: EVENT_AI_INPUT, data: part.text, codecHeaders });
        break;
      }
      case 'file': {
        const codecHeaders: Record<string, string> = {};
        fKind.write(codecHeaders, 'user-message');
        fPartType.write(codecHeaders, 'file');
        fMessageId.write(codecHeaders, messageId);
        fMediaType.write(codecHeaders, part.mediaType);
        payloads.push({ name: EVENT_AI_INPUT, data: part.url, codecHeaders });
        break;
      }
      default: {
        if (isDataUIPart(part)) {
          const codecHeaders: Record<string, string> = {};
          fKind.write(codecHeaders, 'user-message');
          fPartType.write(codecHeaders, part.type);
          fMessageId.write(codecHeaders, messageId);
          fId.write(codecHeaders, part.id);
          payloads.push({ name: EVENT_AI_INPUT, data: part.data, codecHeaders });
        }
        break;
      }
    }
  }

  if (payloads.length === 0) {
    // Always emit at least one part so the decoder can reconstruct the codec-message-id and role from headers, even when the user-message carried no encodable parts.
    const codecHeaders: Record<string, string> = {};
    fKind.write(codecHeaders, 'user-message');
    fPartType.write(codecHeaders, 'text');
    fMessageId.write(codecHeaders, messageId);
    payloads.push({ name: EVENT_AI_INPUT, data: '', codecHeaders });
  }

  return payloads;
};

const encodeUserMessage = async (
  input: UserMessage<AI.UIMessage>,
  core: InputAdapterCore,
  opts: InputEncodeContext['opts'],
): Promise<void> => {
  const payloads = encodeMessagePayloads(input.message);
  // Stamp role (a transport header) on every payload so the decoder can
  // reconstruct a `role: 'user'` UIMessage.
  for (const payload of payloads) {
    payload.transportHeaders = { ...payload.transportHeaders, [HEADER_ROLE]: 'user' };
  }
  await core.publishDiscreteBatch(payloads, opts);
};

const encode = async (input: VercelInput, core: InputAdapterCore, { opts }: InputEncodeContext): Promise<void> => {
  switch (input.kind) {
    case 'user-message': {
      await encodeUserMessage(input, core, opts);
      return;
    }
    case 'regenerate': {
      // Wire-only signal: no domain payload. `parent` / `target` ride the
      // transport headers built by the client-session (via opts).
      const codecHeaders: Record<string, string> = {};
      fKind.write(codecHeaders, 'regenerate');
      await core.publishDiscrete({ name: EVENT_AI_INPUT, data: '', codecHeaders }, opts);
      return;
    }
    case 'tool-result': {
      const codecHeaders: Record<string, string> = {};
      fKind.write(codecHeaders, 'tool-result');
      fToolCallId.write(codecHeaders, input.payload.toolCallId);
      await core.publishDiscrete({ name: EVENT_AI_INPUT, data: { output: input.payload.output }, codecHeaders }, opts);
      return;
    }
    case 'tool-result-error': {
      const codecHeaders: Record<string, string> = {};
      fKind.write(codecHeaders, 'tool-result-error');
      fToolCallId.write(codecHeaders, input.payload.toolCallId);
      await core.publishDiscrete(
        { name: EVENT_AI_INPUT, data: { message: input.payload.message }, codecHeaders },
        opts,
      );
      return;
    }
    case 'tool-approval-response': {
      const codecHeaders: Record<string, string> = {};
      fKind.write(codecHeaders, 'tool-approval-response');
      fToolCallId.write(codecHeaders, input.payload.toolCallId);
      fApproved.write(codecHeaders, input.payload.approved);
      fReason.write(codecHeaders, input.payload.reason);
      await core.publishDiscrete({ name: EVENT_AI_INPUT, data: '', codecHeaders }, opts);
      return;
    }
  }
};

// ---------------------------------------------------------------------------
// Decode (ai-input → VercelInput)
// ---------------------------------------------------------------------------

/**
 * Decode one user-message wire part into a one-part UIMessage. The reducer
 * merges parts sharing a codec-message-id into a single message. The part type
 * is read from the dedicated `partType` codec header (the `kind` header is the
 * uniform `'user-message'` dispatch key for every part).
 * @param data - The wire data.
 * @param codecHeaders - The codec-tier headers (`partType`, messageId, …).
 * @param transportHeaders - The transport-tier headers (carries the role).
 * @returns A single `user-message` input, or an empty array when the part type is unrecognised.
 */
const decodeUserMessagePart = (
  data: unknown,
  codecHeaders: Record<string, string>,
  transportHeaders: Record<string, string>,
): VercelInput[] => {
  // CAST: HEADER_ROLE is wire data; the role string is trusted as a UIMessage role.
  const role = (transportHeaders[HEADER_ROLE] ?? 'user') as AI.UIMessage['role'];
  const messageId = fMessageId.read(codecHeaders) ?? '';
  const partType = fPartType.read(codecHeaders);

  let part: AI.UIMessage['parts'][number] | undefined;

  switch (partType) {
    case 'text': {
      part = { type: 'text', text: typeof data === 'string' ? data : '' };
      break;
    }
    case 'file': {
      part = {
        type: 'file',
        mediaType: fMediaType.read(codecHeaders),
        url: typeof data === 'string' ? data : '',
      };
      break;
    }
    default: {
      if (isDataEventName(partType)) {
        part = stripUndefined({ type: partType, id: fId.read(codecHeaders), data });
      }
      break;
    }
  }

  if (!part) return [];

  const message: AI.UIMessage = { id: messageId, role, parts: [part] };
  const userMessage: UserMessage<AI.UIMessage> = { kind: 'user-message', message };
  return [userMessage];
};

const decodeClientToolResult = (
  codecMessageId: string,
  codecHeaders: Record<string, string>,
  data: unknown,
): VercelInput[] => {
  const parsed = isToolOutputAvailableWireData(data) ? data : undefined;
  return [
    {
      kind: 'tool-result',
      codecMessageId,
      payload: { toolCallId: fToolCallId.read(codecHeaders), output: parsed?.output },
    },
  ];
};

const decodeClientToolResultError = (
  codecMessageId: string,
  codecHeaders: Record<string, string>,
  data: unknown,
): VercelInput[] => {
  const parsed = isClientToolResultErrorWireData(data) ? data : undefined;
  return [
    {
      kind: 'tool-result-error',
      codecMessageId,
      payload: { toolCallId: fToolCallId.read(codecHeaders), message: parsed?.message ?? '' },
    },
  ];
};

const decodeClientToolApprovalResponse = (
  codecMessageId: string,
  codecHeaders: Record<string, string>,
): VercelInput[] => [
  {
    kind: 'tool-approval-response',
    codecMessageId,
    payload: stripUndefined({
      toolCallId: fToolCallId.read(codecHeaders),
      approved: fApproved.read(codecHeaders) ?? false,
      reason: fReason.read(codecHeaders),
    }),
  },
];

const decode = ({ codecKind, data, codecHeaders, transportHeaders }: InputDecodeContext): VercelInput[] => {
  const codecMessageId = transportHeaders[HEADER_CODEC_MESSAGE_ID] ?? '';

  // A single `kind` switch dispatches every input; `user-message` is uniform
  // with the rest and carries its part type in the dedicated `partType` header.
  switch (codecKind) {
    case 'user-message': {
      return decodeUserMessagePart(data, codecHeaders, transportHeaders);
    }
    case 'tool-result': {
      return decodeClientToolResult(codecMessageId, codecHeaders, data);
    }
    case 'tool-result-error': {
      return decodeClientToolResultError(codecMessageId, codecHeaders, data);
    }
    case 'tool-approval-response': {
      return decodeClientToolApprovalResponse(codecMessageId, codecHeaders);
    }
    case 'regenerate': {
      // Wire-only signal — `parent` / `msg-regenerate` ride the transport
      // headers, read directly by the agent's input-event lookup. No fold here.
      return [];
    }
    default: {
      return [];
    }
  }
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** The complete Vercel input adapter consumed by {@link defineCodec}. */
export const vercelInputs: InputAdapter<VercelInput> = { encode, decode };
