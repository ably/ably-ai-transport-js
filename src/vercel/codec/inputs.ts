/**
 * Vercel input (`ai-input`) descriptors — the single source of truth for the
 * `VercelInput` wire mapping, the message fan-out included.
 *
 * `defineCodec` injects the direction-scoped `{ event, batch }` builder; the
 * generic input drivers consume the returned array. The chunk action carries
 * the AI SDK's own tool-output chunk as its wire data; the approval decision
 * is field-mapped; `regenerate` carries the id it regenerates from; the multi-part message
 * is a `batch` that fans each `UIMessage` part out into one wire event, so a
 * large body still fits the wire.
 */

import type * as AI from 'ai';

import { HEADER_ROLE } from '../../constants.js';
import type { InputBuilder, InputDescriptor } from '../../core/codec/index.js';
import type { VercelInput } from './events.js';
import { fApproved, fId, fMediaType, fMessageId, fReason, fTargetMessageId, fToolCallId } from './fields.js';
import { asString, readToolOutputChunkWireData } from './wire-data.js';

/** Fallback for a message with no encodable parts (see the `message` batch). */
const EMPTY_MESSAGE_PARTS: AI.UIMessage['parts'] = [{ type: 'text', text: '' }];

/**
 * Part types the `message` batch's `parts` sub-table can encode — must stay
 * in step with that table. Parts outside this set (e.g. `step-start`, tool
 * parts) have no wire mapping; `explode` filters them so the batch always
 * yields at least one encodable part and the message round-trips.
 * @param part - The UIMessage part to test.
 * @returns Whether the part has a wire mapping in the batch's part table.
 */
const isEncodablePart = (part: AI.UIMessage['parts'][number]): boolean =>
  part.type === 'text' || part.type === 'file' || part.type.startsWith('data-');

/**
 * The Vercel codec's `ai-input` descriptors, built from the injected
 * direction-scoped builder.
 * @param builder - The `{ event, batch }` builder curried on `VercelInput`.
 * @param builder.event - Define a single-event input (payload-nested, or `wireOnly`).
 * @param builder.batch - Define a multi-part (batch) input that fans out into one wire event per part.
 * @returns The input descriptor table the generic input drivers consume.
 */
export const inputs = ({ event, batch }: InputBuilder<VercelInput>): readonly InputDescriptor<VercelInput>[] => [
  // --- tool resolution: the AI SDK's own chunk as the body ---------------------

  // The chunk is the wire data, so the decoded body carries exactly what the
  // provider's reducer consumes; the addressed message id is a header beside
  // it. Malformed wire data throws at this trust boundary — the receive path
  // drops the one message and surfaces an error.
  event('chunk', {
    fields: [fTargetMessageId],
    data: {
      encode: (payload) => payload.chunk,
      decode: (d) => ({ chunk: readToolOutputChunkWireData(d) }),
    },
  }),

  // --- approval decision: the codec-defined body -------------------------------

  event('approval', { fields: [fTargetMessageId, fToolCallId, fApproved, fReason] }),

  // --- regeneration signal ------------------------------------------------------

  // `regenerate` names the message useChat is regenerating from. The id is
  // domain data for the agent to act on; it describes no conversation
  // structure and nothing in the transport reads it.
  event('regenerate', { fields: [fTargetMessageId] }),

  // --- multi-part client message ------------------------------------------------

  // The message fans out into one wire event per part, all sharing the
  // `message` kind and transport-message-id, each carrying its `partType`. The
  // message id (a codec header) and role (a transport header) are per-message,
  // stamped on every part so the decode side can rebuild the envelope from any
  // one; a consumer merges parts sharing a transport-message-id.
  batch('message', {
    // A message with no encodable parts (empty, or only unmapped types like
    // step-start) still publishes one empty text part, so the transport-message-id
    // and role survive and it round-trips to a one-part message. The driver's
    // bare-headers fallback cannot round-trip (it carries no partType), so the
    // ≥1-encodable-part guarantee lives here.
    explode: (input) => {
      const encodable = input.payload.parts.filter((part) => isEncodablePart(part));
      return encodable.length > 0 ? encodable : EMPTY_MESSAGE_PARTS;
    },
    partTypeOf: (part) => part.type,
    parts: (p) => [
      p('text', { data: { encode: (x) => x.text, decode: (d) => ({ text: asString(d) }) } }),
      p('file', {
        fields: [fMediaType],
        data: { encode: (x) => x.url, decode: (d) => ({ url: asString(d) }) },
      }),
      p('data-*', {
        fields: [fId],
        data: { encode: (x) => x.data, decode: (d) => ({ data: d }) },
      }),
    ],
    messageHeaders: (input) => {
      const codecHeaders: Record<string, string> = {};
      fMessageId.write(codecHeaders, input.payload.id);
      return { codecHeaders, transportHeaders: { [HEADER_ROLE]: input.payload.role } };
    },
    assemble: (part, { codecHeaders, transportHeaders }) => {
      // CAST: HEADER_ROLE is wire data; the role string is trusted as a UIMessage role.
      const role = (transportHeaders[HEADER_ROLE] ?? 'user') as AI.UIMessage['role'];
      const id = fMessageId.read(codecHeaders) ?? '';
      return { payload: { id, role, parts: [part] } };
    },
  }),
];
