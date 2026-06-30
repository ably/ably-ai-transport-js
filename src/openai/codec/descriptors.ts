/**
 * Declarative descriptor tables for the OpenAI Responses codec (text increment).
 *
 * Output side:
 * - **Assistant text is the one streamed family.** `response.content_part.added`
 *   → `response.output_text.delta` → `response.output_text.done` map onto a
 *   `stream(...)` with `idField: 'item_id'` and `deltaField: 'delta'` — both
 *   top-level string properties present on all three phases, which is what the
 *   stream model requires. The closing `output_text.done` is rebuilt from the
 *   accumulated stream text via `decodeEnd`.
 * - **Lifecycle and the item/content-part envelopes are discrete events.** Each
 *   carries no streamed string and hence no `status` header.
 *
 * Input side: empty in this increment (assistant output only) — see {@link inputs}.
 *
 * Function calls, reasoning, refusals, and hosted tools are added in later
 * increments by adding entries here — the split established now does not change.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { InputDescriptor, OutputBuilder, OutputDescriptor } from '../../core/codec/index.js';
import { jsonField, strField } from '../../core/codec/index.js';
import type { OpenAIInput, OpenAIOutput } from './events.js';

// Coerce arbitrary wire data to a string, defaulting to empty.
const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

// Header fields used to reconstruct the text stream's content-part position.
const fOutputIndex = jsonField<number, 'output_index'>('output_index');
const fContentIndex = jsonField<number, 'content_index'>('content_index');
const fPart = jsonField<Responses.ResponseContentPartAddedEvent['part'], 'part'>('part');

/**
 * The OpenAI codec's `ai-output` descriptor table.
 * @param builder - The `{ event, stream }` builder curried on {@link OpenAIOutput}.
 * @param builder.event - Declare a discrete output event.
 * @param builder.stream - Declare a streamed output family.
 * @returns The output descriptor table.
 */
export const outputs = ({ event, stream }: OutputBuilder<OpenAIOutput>): readonly OutputDescriptor<OpenAIOutput>[] => {
  // The response-lifecycle events all carry the full Response snapshot as wire
  // data and share one decode shape.
  // CAST on decode: wire data is JSON parsed at a trust boundary; the Response
  // shape is asserted via the chunk type the descriptor is narrowed to.
  const responseEvent = (
    type: Extract<OpenAIOutput, { response: Responses.Response }>['type'],
  ): OutputDescriptor<OpenAIOutput> =>
    event(type, { data: { encode: (c) => c.response, decode: (d) => ({ response: d as Responses.Response }) } });

  return [
    // --- assistant text: the one streamed family -----------------------------
    stream('text', {
      start: 'response.content_part.added',
      delta: 'response.output_text.delta',
      end: 'response.output_text.done',
      idField: 'item_id',
      deltaField: 'delta',
      fields: [fOutputIndex, fContentIndex, fPart],
      // The end chunk carries output_index/content_index on its closing headers;
      // the text is the accumulated stream. (item_id is the stream id.)
      decodeEnd: ({ streamId, accumulated, closingCodecHeaders }) => [
        {
          type: 'response.output_text.done',
          item_id: streamId,
          output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
          content_index: fContentIndex.read(closingCodecHeaders) ?? 0,
          text: accumulated,
          logprobs: [],
          sequence_number: 0,
        },
      ],
    }),

    // --- response lifecycle (discrete; Response snapshot rides as wire data) --
    responseEvent('response.created'),
    responseEvent('response.in_progress'),
    responseEvent('response.queued'),
    responseEvent('response.completed'),
    responseEvent('response.incomplete'),
    responseEvent('response.failed'),
    event('error', {
      data: { encode: (c) => c.message, decode: (d) => ({ message: asString(d) }) },
    }),

    // --- item / content-part envelopes (discrete) ----------------------------
    // CAST on decode: the output item rides as JSON wire data (trust boundary).
    event('response.output_item.added', {
      data: { encode: (c) => c.item, decode: (d) => ({ item: d as Responses.ResponseOutputItem }) },
    }),
    event('response.output_item.done', {
      data: { encode: (c) => c.item, decode: (d) => ({ item: d as Responses.ResponseOutputItem }) },
    }),
    // content_part.done closes the part; the reducer ignores it, but it is
    // declared so the agent can publish it without an "unsupported event" error.
    event('response.content_part.done', {
      fields: [strField('item_id'), fOutputIndex, fContentIndex],
    }),
  ];
};

/**
 * The OpenAI codec's `ai-input` descriptor table.
 *
 * Empty in this increment: the user-input turn rides the `ai-input` wire, but
 * its representation (fanning a turn's content out into wire parts and merging
 * them back in the reducer) is a deliberate design step taken in the next
 * increment. This increment streams assistant output only. `OpenAIInput` still
 * declares the well-known `user-message` variant so `createUserMessage` is
 * available, but nothing encodes or decodes it yet.
 *
 * TODO(AIT-742): add the user-message input mapping (fan-out + reducer merge).
 * @returns An empty input descriptor table.
 */
export const inputs = (): readonly InputDescriptor<OpenAIInput>[] => [];
