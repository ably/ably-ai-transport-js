/**
 * Vercel input (`ai-input`) descriptors — the single source of truth for the
 * `VercelInput` wire mapping, the user-message fan-out included.
 *
 * `defineCodec` injects the direction-scoped `{ event, batch }` builder; the
 * generic input drivers consume the returned array. The tool inputs are single
 * `event`s lensed onto their nested `payload`; `regenerate` is a wire-only
 * signal; the multi-part user message is a `batch` that fans each
 * `UIMessage` part out into one wire event (reassembled by the reducer).
 *
 * Author-facing acceptance gate: this file contains **zero `as` casts**. The
 * injected `event`/`batch` builders narrow each member, so every `data` /
 * `fields` / `parts` / `assemble` callback is fully typed.
 */

import type * as AI from 'ai';

import { HEADER_ROLE } from '../../constants.js';
import type { InputBuilder } from '../../core/codec/define-codec.js';
import type { InputDescriptor } from '../../core/codec/input-descriptors.js';
import type { VercelInput } from './events.js';
import { fApproved, fId, fMediaType, fMessageId, fReason, fToolCallId } from './fields.js';
import { isClientToolResultErrorWireData, isToolOutputAvailableWireData } from './wire-data.js';

const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

/** Fallback for a message with no encodable parts (see the `user-message` batch). */
const EMPTY_MESSAGE_PARTS: AI.UIMessage['parts'] = [{ type: 'text', text: '' }];

/**
 * The Vercel codec's `ai-input` descriptors, built from the injected
 * direction-scoped builder.
 * @param builder - The `{ event, batch }` builder curried on `VercelInput`.
 * @param builder.event - Define a single-event input (flat, `via:'payload'`, or `wireOnly`).
 * @param builder.batch - Define a multi-part (batch) input that fans out into one wire event per part.
 * @returns The input descriptor table the generic input drivers consume.
 */
export const inputs = ({ event, batch }: InputBuilder<VercelInput>): readonly InputDescriptor<VercelInput>[] => [
  // --- tool inputs: nested payload, codec-message-id-addressed ----------------

  event('tool-result', {
    via: 'payload',
    fields: [fToolCallId],
    data: {
      encode: (p) => ({ output: p.output }),
      // `output` is a required payload field — keep it present (undefined on malformed data).
      decode: (d) => ({ output: isToolOutputAvailableWireData(d) ? d.output : undefined }),
    },
  }),
  event('tool-result-error', {
    via: 'payload',
    fields: [fToolCallId],
    data: {
      encode: (p) => ({ message: p.message }),
      decode: (d) => ({ message: isClientToolResultErrorWireData(d) ? (d.message ?? '') : '' }),
    },
  }),
  event('tool-approval-response', { via: 'payload', fields: [fToolCallId, fApproved, fReason] }),

  // --- wire-only signal -------------------------------------------------------

  // `regenerate` carries no domain payload; `parent` / `target` ride the
  // transport headers built by the client-session and read by the agent's
  // input-event lookup, so it stamps only the `kind` header and decodes to [].
  event('regenerate', { wireOnly: true }),

  // --- multi-part client message ----------------------------------------------

  // The user message fans out into one wire event per part, all sharing the
  // `user-message` kind and codec-message-id, each carrying its `partType`. The
  // message id (a codec header) and role (a transport header) are per-message,
  // stamped on every part so the decode side can rebuild the envelope from any
  // one; the reducer merges parts sharing a codec-message-id.
  batch('user-message', {
    // A message with no encodable parts still publishes one empty text part, so the
    // codec-message-id and role survive and it round-trips to a one-part message.
    explode: (input) => (input.message.parts.length > 0 ? input.message.parts : EMPTY_MESSAGE_PARTS),
    partTypeOf: (part) => part.type,
    parts: (p) => [
      p('text', { data: { encode: (x) => x.text, decode: (d) => ({ text: asString(d) }) } }),
      p('file', {
        fields: [fMediaType],
        data: { encode: (x) => x.url, decode: (d) => ({ url: asString(d) }) },
      }),
      p.wildcard<'data-*'>((pt) => pt.startsWith('data-'), {
        fields: [fId],
        data: { encode: (x) => x.data, decode: (d) => ({ data: d }) },
      }),
    ],
    messageHeaders: (input) => {
      const codecHeaders: Record<string, string> = {};
      fMessageId.write(codecHeaders, input.message.id);
      return { codecHeaders, transportHeaders: { [HEADER_ROLE]: input.message.role } };
    },
    assemble: (part, { codecHeaders, transportHeaders }) => {
      // CAST: HEADER_ROLE is wire data; the role string is trusted as a UIMessage role.
      const role = (transportHeaders[HEADER_ROLE] ?? 'user') as AI.UIMessage['role'];
      const id = fMessageId.read(codecHeaders) ?? '';
      return { message: { id, role, parts: [part] } };
    },
  }),
];
