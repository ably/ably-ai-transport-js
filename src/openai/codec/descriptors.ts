/**
 * Declarative descriptor tables for the OpenAI Responses codec (text increment).
 *
 * Output side:
 * - **Assistant text is the one streamed family.** `response.content_part.added`
 *   → `response.output_text.delta` → `response.output_text.done` map onto a
 *   `stream(...)` with `streamId: { field: 'item_id' }` and `deltaField: 'delta'` — both
 *   top-level string properties present on all three phases, which is what the
 *   stream model requires. The closing `output_text.done` is rebuilt from the
 *   accumulated stream text via `decodeEnd`.
 * - **Lifecycle and the item/content-part envelopes are discrete events.** Each
 *   carries no streamed string and hence no `status` header. A server-side
 *   **function call** rides these same item envelopes — a `function_call` is a
 *   `ResponseOutputItem`, so `output_item.added`/`output_item.done` carry it
 *   with no dedicated descriptor (the `done` envelope holds the complete
 *   arguments). The function call's *result* is the codec's own
 *   `function_call_output` event (see below).
 * - **An `ignore(...)` set is the escape hatch for events not yet streamed.**
 *   The aim is to carry everything the transport can, streaming included; where
 *   we haven't yet built a clean path for a provider event, we drop it *for now*
 *   rather than let it trip the encoder's safety net (any event that is neither
 *   described nor ignored throws). Today this covers a reasoning model's streamed
 *   summary / raw reasoning text, refusals, text annotations, and the
 *   function-call argument deltas — content whose final value we already carry on
 *   the item's `output_item.done`, or that we don't render yet, so dropping the
 *   deltas loses only the incremental streaming, not correctness. The exhaustive
 *   list (and what still throws) is documented at the ignore entries below.
 *
 * Input side: the user message is a `batch` that fans the user turn's content
 * parts out into one `ai-input` event per part (one for a plain text prompt),
 * reassembled and merged by the reducer — see {@link inputs}. The `regenerate`
 * signal is a wire-only event: it stamps only its `kind` header (the agent
 * reads `target` / `parent` via the input-event lookup) and folds to nothing.
 *
 * Reasoning, refusals, and hosted tools are added in later increments by adding
 * entries here — the split established now does not change.
 */

import type { Responses } from 'openai/resources/responses/responses';

import { HEADER_ROLE } from '../../constants.js';
import type { InputBuilder, InputDescriptor, OutputBuilder, OutputDescriptor } from '../../core/codec/index.js';
import { jsonField, strField } from '../../core/codec/index.js';
import type { OpenAIInput, OpenAIOutput, OpenAITurn } from './events.js';

// Coerce arbitrary wire data to a string, defaulting to empty.
const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

// Header fields used to reconstruct the text stream's content-part position.
// `item_id` is a declared field (re-stamped on every append) so the decoded
// start and deltas carry it for routing — the transport stream id is opaque.
const fItemId = strField('item_id');
const fOutputIndex = jsonField<number, 'output_index'>('output_index');
const fContentIndex = jsonField<number, 'content_index'>('content_index');
const fPart = jsonField<Responses.ResponseContentPartAddedEvent['part'], 'part'>('part');

/**
 * The OpenAI codec's `ai-output` descriptor table.
 * @param builder - The `{ event, stream, ignore }` builder curried on {@link OpenAIOutput}.
 * @param builder.event - Declare a discrete output event.
 * @param builder.stream - Declare a streamed output family.
 * @param builder.ignore - Declare a provider event to drop on encode (not yet streamed).
 * @returns The output descriptor table.
 */
export const outputs = ({
  event,
  stream,
  ignore,
}: OutputBuilder<OpenAIOutput>): readonly OutputDescriptor<OpenAIOutput>[] => {
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
      streamId: { field: 'item_id' },
      deltaField: 'delta',
      fields: [fItemId, fOutputIndex, fContentIndex, fPart],
      deltaFields: [fItemId],
      // The end chunk carries output_index/content_index on its closing headers;
      // the text is the accumulated stream. (item_id rides the codec headers.)
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
    // content_part.done closes the part; the reducer folds it to nothing. It is
    // declared (rather than left to the codec's ignore policy) so the part
    // boundary still round-trips as a discrete event on the wire.
    event('response.content_part.done', {
      fields: [strField('item_id'), fOutputIndex, fContentIndex],
    }),

    // --- server-executed tool result (codec's own output event) --------------
    // Not a Responses stream event: OpenAI surfaces tool output only as model
    // input on the next turn, so the agent publishes this after running the
    // tool. The reducer appends the item to the assistant turn alongside the
    // matching function_call.
    // CAST on decode: the FunctionCallOutput item rides as JSON wire data (trust
    // boundary); the shape is asserted via the event the descriptor narrows to.
    event('function_call_output', {
      data: { encode: (c) => c.item, decode: (d) => ({ item: d as Responses.ResponseInputItem.FunctionCallOutput }) },
    }),

    // --- events we don't yet model ------------------------------------------
    //
    // TODO(AIT-742): the two lists below are exhaustive against openai@6.44.0's
    // ResponseStreamEvent union — revisit on a dep bump. Two states:
    //  • ignore(...)'d here → dropped on encode, never breaks a run. These are
    //    streamed deltas whose final value we already carry (via the item's
    //    output_item.done), or content we don't render yet. We WANT to stream
    //    these — each is a tracked gap, not a decision to discard.
    //  • everything else → still throws (the encoder's safety net), because it
    //    only appears once you opt into a hosted tool / modality we don't
    //    support. Failing loudly beats silently dropping that content.
    //
    // Ignored for now:
    //  reasoning (GPT-5.x): the reasoning *item* still rides output_item.*; only
    //  the streamed summary / raw reasoning text is dropped.
    //  TODO(AIT-742): stream the summary (render the model's "thinking"). To
    //  reproduce these events: the /responses request must opt in with
    //  `reasoning: { summary: 'auto' }` (off by default — the demo doesn't set
    //  it), AND the prompt must make the model actually reason — a trivial prompt
    //  yields ~0 reasoning tokens and an empty summary. Reliable repro against
    //  gpt-5.5: "12 balls, one a different weight; find it and whether it's
    //  heavier/lighter in exactly 3 weighings." That emits, per reasoning item,
    //  ONE OR MORE summary parts, each a reasoning_summary_part.added →
    //  reasoning_summary_text.delta* → reasoning_summary_text.done — all sharing
    //  one item_id, distinguished only by a numeric summary_index. So streaming
    //  them needs a stream id composed of item_id + summary_index: the same "the
    //  id isn't a single top-level string" blocker as the function-call arg
    //  deltas below (whose id nests under item.id). One core change — deriving a
    //  stream id from a nested/composite key — unblocks both.
    ignore('response.reasoning_summary_part.added'),
    ignore('response.reasoning_summary_part.done'),
    ignore('response.reasoning_summary_text.delta'),
    ignore('response.reasoning_summary_text.done'),
    ignore('response.reasoning_text.delta'),
    ignore('response.reasoning_text.done'),
    //  refusal: the refusal still renders from the message item's output_item.done.
    //  TODO: stream it.
    ignore('response.refusal.delta'),
    ignore('response.refusal.done'),
    //  annotations / citations: the text streams regardless. TODO: carry them.
    ignore('response.output_text.annotation.added'),
    //  function-call argument deltas: the complete arguments arrive on the
    //  function_call's output_item.done; they can't key the stream model yet
    //  (their start, output_item.added, nests the id under item.id). TODO: stream.
    ignore('response.function_call_arguments.delta'),
    ignore('response.function_call_arguments.done'),
    //
    // Not modelled → throw (opt-in hosted tools / modalities; add support when we
    // take each on):
    //  audio out:        response.audio.delta / .done, response.audio.transcript.delta / .done
    //  web search:       response.web_search_call.in_progress / .searching / .completed
    //  file search:      response.file_search_call.in_progress / .searching / .completed
    //  code interpreter: response.code_interpreter_call.in_progress / .interpreting / .completed,
    //                    response.code_interpreter_call_code.delta / .done
    //  image gen:        response.image_generation_call.in_progress / .generating / .partial_image / .completed
    //  MCP:              response.mcp_call.in_progress / .completed / .failed,
    //                    response.mcp_call_arguments.delta / .done,
    //                    response.mcp_list_tools.in_progress / .completed / .failed
    //  custom tools:     response.custom_tool_call_input.delta / .done
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
 * @param builder.event - Declare a discrete input event.
 * @param builder.batch - Declare a multi-part (fan-out) input.
 * @returns The input descriptor table.
 */
export const inputs = ({ event, batch }: InputBuilder<OpenAIInput>): readonly InputDescriptor<OpenAIInput>[] => [
  // Regenerate is a wire-only signal: it references an existing assistant
  // message by id, carries no payload, and folds to nothing. The agent reads
  // `target` / `parent` from the wire headers via the input-event lookup.
  event('regenerate', { wireOnly: true }),
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
    assemble: (part, { transportHeaders }) => {
      // Annotate the turn so the items literal is contextually typed as
      // OpenAIItem (narrowing `type: 'message'`), independent of how the
      // assemble callback's return type is inferred for the input union.
      const message: OpenAITurn = {
        // CAST: HEADER_ROLE is wire data; the role string is trusted as a turn role.
        role: (transportHeaders[HEADER_ROLE] ?? 'user') as OpenAITurn['role'],
        items: [{ type: 'message', role: 'user', content: [part] }],
      };
      return { message };
    },
  }),
];
