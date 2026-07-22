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
 * Author-facing acceptance gate: the injected `event`/`batch` builders narrow
 * each member, so every `data` / `fields` / `parts` / `assemble` callback is
 * fully typed. The file's single `as` cast is the wire trust boundary on the
 * inbound role header (see `assemble`).
 */

import type * as AI from 'ai';

import { HEADER_ROLE } from '../../constants.js';
import type { InputBuilder, InputDescriptor } from '../../core/codec/index.js';
import type { ForkSeed, VercelInput } from './events.js';
import { fApproved, fId, fMediaType, fMessageId, fReason, fToolCallId } from './fields.js';
import {
  asString,
  isClientToolResultErrorWireData,
  isToolOutputAvailableWireData,
  readForkSeedWireData,
} from './wire-data.js';

/** Fallback for a message with no encodable parts (see the `user-message` batch). */
const EMPTY_MESSAGE_PARTS: AI.UIMessage['parts'] = [{ type: 'text', text: '' }];

/**
 * Spread the encoded fork-continuation `forkSeed` into a tool-result /
 * tool-result-error wire `data` envelope, omitting the key when absent. The
 * seed is plain JSON (a list of `{ codecMessageId, message }` entries), so it
 * round-trips in `data` alongside `output` / `message`.
 * @param seed - The payload's `forkSeed`, if present.
 * @returns `{ forkSeed }` when present, else `{}`.
 */
const encodeForkSeed = (seed: ForkSeed | undefined): { forkSeed?: ForkSeed } =>
  seed === undefined ? {} : { forkSeed: seed };

/**
 * Decode the fork-continuation `forkSeed` from a tool-result /
 * tool-result-error wire `data` envelope, validating and filtering it at this
 * trust boundary (see {@link readForkSeedWireData} — malformed parts are dropped
 * so they never reach the reducer).
 * @param d - The JSON-parsed input `data` envelope.
 * @returns `{ forkSeed }` when a valid seed is present, else `{}`.
 */
const decodeForkSeed = (d: unknown): { forkSeed?: ForkSeed } => {
  const seed = readForkSeedWireData(d);
  return seed === undefined ? {} : { forkSeed: seed };
};

/**
 * Part types the `user-message` batch's `parts` sub-table can encode — must
 * stay in step with that table. Parts outside this set (e.g. `step-start`,
 * tool parts) have no wire mapping; `explode` filters them so the batch always
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
  // --- tool inputs: nested payload, codec-message-id-addressed ----------------

  event('tool-result', {
    fields: [fToolCallId],
    data: {
      encode: (p) => ({ output: p.output, ...encodeForkSeed(p.forkSeed) }),
      // Malformed wire data decodes to undefined, which the rebuild boundary strips
      // — the folded payload then has no `output` key (reads as undefined). The
      // optional `forkSeed` rides a fork continuation (omitted otherwise).
      decode: (d) => ({
        output: isToolOutputAvailableWireData(d) ? d.output : undefined,
        ...decodeForkSeed(d),
      }),
    },
  }),
  event('tool-result-error', {
    fields: [fToolCallId],
    data: {
      encode: (p) => ({ message: p.message, ...encodeForkSeed(p.forkSeed) }),
      decode: (d) => ({
        message: isClientToolResultErrorWireData(d) ? (d.message ?? '') : '',
        ...decodeForkSeed(d),
      }),
    },
  }),
  event('tool-approval-response', { fields: [fToolCallId, fApproved, fReason] }),

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
    // A message with no encodable parts (empty, or only unmapped types like
    // step-start) still publishes one empty text part, so the codec-message-id
    // and role survive and it round-trips to a one-part message. The driver's
    // bare-headers fallback cannot round-trip (it carries no partType), so the
    // ≥1-encodable-part guarantee lives here.
    explode: (input) => {
      const encodable = input.message.parts.filter((part) => isEncodablePart(part));
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
