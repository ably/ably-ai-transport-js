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
 * Input side: the user message is a `batch` that fans the user turn's content
 * parts out into one `ai-input` event per part (one for a plain text prompt),
 * reassembled and merged by the reducer — see {@link inputs}.
 *
 * Function calls, reasoning, refusals, and hosted tools are added in later
 * increments by adding entries here — the split established now does not change.
 */

import type { Responses } from 'openai/resources/responses/responses';

import { HEADER_ROLE } from '../../constants.js';
import type { InputBuilder, InputDescriptor, OutputBuilder, OutputDescriptor } from '../../core/codec/index.js';
import { jsonField, strField } from '../../core/codec/index.js';
import type { OpenAIInput, OpenAIOutput, OpenAITurn } from './events.js';

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
 * The user message is a `batch`: a user turn is a single input message whose
 * content parts (`input_text`, and later `input_image` / `input_file`) are
 * fanned out into one `ai-input` event per part, all sharing `kind:
 * user-message` and the turn's codec-message-id, each carrying its `partType`
 * and the turn's `role`. The transport groups the parts into one node by their
 * shared codec-message-id; the reducer then merges them within that node (see
 * the reducer's user-message merge). A turn with no encodable part still emits
 * one empty text part so the message round-trips.
 *
 * Assumes a user turn is a **single** input message: the fan-out carries no
 * item boundary, so all content parts reassemble into one message item. (A turn
 * with multiple message items would be merged into one — see `OpenAITurn`.)
 *
 * `input_text` is the only content part this increment encodes.
 * TODO(AIT-742): add `input_image` and `input_file` parts for richer prompts.
 * @param builder - The `{ event, batch }` builder curried on {@link OpenAIInput}.
 * @param builder.batch - Declare a multi-part (fan-out) input.
 * @returns The input descriptor table.
 */
export const inputs = ({ batch }: InputBuilder<OpenAIInput>): readonly InputDescriptor<OpenAIInput>[] => [
  batch('user-message', {
    explode: (input) => {
      // Assumption in use here: a user turn is a single input message, so we
      // flatten content parts across items with no item boundary on the wire.
      // A multi-item turn would collapse into one message on reassembly.
      const parts: Responses.ResponseInputText[] = [];
      for (const item of input.message.items) {
        if (item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part.type === 'input_text') parts.push(part);
        }
      }
      // Guarantee ≥1 encodable part so an empty prompt still round-trips.
      const empty: Responses.ResponseInputText = { type: 'input_text', text: '' };
      return parts.length > 0 ? parts : [empty];
    },
    partTypeOf: (part) => part.type,
    parts: (p) => [p('input_text', { data: { encode: (part) => part.text, decode: (d) => ({ text: asString(d) }) } })],
    messageHeaders: (input) => ({ transportHeaders: { [HEADER_ROLE]: input.message.role } }),
    assemble: (part, { transportHeaders }) => ({
      // CAST: HEADER_ROLE is wire data; the role string is trusted as a turn role.
      message: {
        role: (transportHeaders[HEADER_ROLE] ?? 'user') as OpenAITurn['role'],
        items: [{ type: 'message', role: 'user', content: [part] }],
      },
    }),
  }),
];
