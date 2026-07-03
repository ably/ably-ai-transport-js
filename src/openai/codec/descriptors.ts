/**
 * Declarative descriptor tables for the OpenAI Responses codec.
 *
 * Output side:
 * - **Content-part streams.** `response.content_part.added` opens three streamed
 *   families, told apart by the added part's type: `output_text` and `refusal`
 *   (on a message) and `reasoning_text` (on a reasoning item). Each fills
 *   `content[content_index]` of its item, so its stream id composes
 *   `item_id + content_index` and its decoded delta carries both. A reasoning
 *   model's streamed summary is a fourth family (`reasoning_summary_text`, keyed
 *   `item_id + summary_index`). Each family rebuilds its closing `*.done` from the
 *   accumulated stream text via `decodeEnd`.
 * - **A server-side function call streams its arguments.** The
 *   `function_call_arguments` family opens on `output_item.added` (claimed only
 *   for a `function_call`; message/reasoning items decline to the discrete
 *   `output_item.added` event), carries the item envelope on the start header,
 *   and streams the `arguments` text. The complete item still arrives on the
 *   discrete `output_item.done`, and the call's *result* is the codec's own
 *   `function_call_output` event (see below).
 * - **Lifecycle and the item / part-close boundaries are discrete events.** Each
 *   carries no streamed string and hence no `status` header. The `*_part.done`
 *   closes (content and reasoning-summary) fold to nothing but are declared so the
 *   part boundary round-trips on the wire.
 * - **No `ignore` set.** Every event OpenAI streams by default is modelled here —
 *   as a stream, a discrete boundary, or lifecycle. The events that appear only
 *   once you opt into a hosted tool / modality the codec doesn't support (web /
 *   file search, code interpreter, image gen, MCP, audio, custom tools, and the
 *   `output_text` annotations those tools cite) are neither described nor ignored,
 *   so the encoder's safety net throws on them — failing loudly beats silently
 *   dropping content. The exhaustive inventory is at the tail of the table below.
 *
 * Input side: the user message is a `batch` that fans the user turn's content
 * parts out into one `ai-input` event per part (one for a plain text prompt),
 * reassembled and merged by the reducer — see {@link inputs}. The `regenerate`
 * signal is a wire-only event: it stamps only its `kind` header (the agent
 * reads `target` / `parent` via the input-event lookup) and folds to nothing.
 *
 * Hosted tools are added by adding entries here; the codec/transport split is
 * unaffected.
 */

import * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';

import { HEADER_ROLE } from '../../constants.js';
import type { InputBuilder, InputDescriptor, OutputBuilder, OutputDescriptor } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { OpenAIInput, OpenAIOutput, OpenAITurn } from './events.js';
import {
  composeItemContent,
  fContentIndex,
  fItem,
  fItemId,
  fOutputIndex,
  fPart,
  fSummaryIndex,
  fSummaryPart,
} from './fields.js';

// Coerce arbitrary wire data to a string, defaulting to empty.
const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

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
    // --- content-part streams: assistant text, refusal, reasoning text -------
    // Three families share the content_part.added start, told apart by the added
    // part's type; each fills content[content_index] of its item, so the stream id
    // composes item_id + content_index and the decoded delta carries both for the
    // reducer to target the exact slot.
    stream('output_text', {
      start: 'response.content_part.added',
      delta: 'response.output_text.delta',
      end: 'response.output_text.done',
      startWhen: (c) => c.part.type === 'output_text',
      streamId: composeItemContent,
      deltaField: 'delta',
      fields: [fItemId, fOutputIndex, fContentIndex, fPart],
      deltaFields: [fItemId, fContentIndex],
      decodeEnd: ({ accumulated, closingCodecHeaders }) => [
        {
          type: 'response.output_text.done',
          item_id: fItemId.read(closingCodecHeaders) ?? '',
          output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
          content_index: fContentIndex.read(closingCodecHeaders) ?? 0,
          text: accumulated,
          logprobs: [],
          sequence_number: 0,
        },
      ],
    }),

    stream('refusal', {
      start: 'response.content_part.added',
      delta: 'response.refusal.delta',
      end: 'response.refusal.done',
      startWhen: (c) => c.part.type === 'refusal',
      streamId: composeItemContent,
      deltaField: 'delta',
      fields: [fItemId, fOutputIndex, fContentIndex, fPart],
      deltaFields: [fItemId, fContentIndex],
      decodeEnd: ({ accumulated, closingCodecHeaders }) => [
        {
          type: 'response.refusal.done',
          item_id: fItemId.read(closingCodecHeaders) ?? '',
          output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
          content_index: fContentIndex.read(closingCodecHeaders) ?? 0,
          refusal: accumulated,
          sequence_number: 0,
        },
      ],
    }),

    stream('reasoning_text', {
      start: 'response.content_part.added',
      delta: 'response.reasoning_text.delta',
      end: 'response.reasoning_text.done',
      startWhen: (c) => c.part.type === 'reasoning_text',
      streamId: composeItemContent,
      deltaField: 'delta',
      fields: [fItemId, fOutputIndex, fContentIndex, fPart],
      deltaFields: [fItemId, fContentIndex],
      decodeEnd: ({ accumulated, closingCodecHeaders }) => [
        {
          type: 'response.reasoning_text.done',
          item_id: fItemId.read(closingCodecHeaders) ?? '',
          output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
          content_index: fContentIndex.read(closingCodecHeaders) ?? 0,
          text: accumulated,
          sequence_number: 0,
        },
      ],
    }),

    // --- reasoning summary text: a reasoning model's streamed "thinking" ------
    // Each reasoning item emits one or more summary parts, all sharing item_id
    // and distinguished by summary_index — so the stream id is composed from the
    // two. The reasoning item itself rides the output_item envelopes; this stream
    // fills its summary[summary_index].text.
    //
    // Provoking summary events (non-obvious) for testing against a real model:
    // the /responses request must opt in with `reasoning: { summary: 'auto' }`
    // (off by default — the demo doesn't set it), AND the prompt must make the
    // model actually reason — a trivial prompt yields ~0 reasoning tokens and an
    // empty summary. Reliable repro against gpt-5.5: the 12-ball weighing puzzle
    // ("12 balls, one a different weight; find it and whether it's heavier or
    // lighter in exactly 3 weighings").
    stream('reasoning_summary_text', {
      start: 'response.reasoning_summary_part.added',
      delta: 'response.reasoning_summary_text.delta',
      end: 'response.reasoning_summary_text.done',
      // A reasoning item has two indexed dimensions — summary[] and content[]
      // (reasoning_text) — both 0-based, so the summary stream id is namespaced
      // to avoid clashing with a reasoning_text content slot on the same item.
      // TODO(AIT-742): decide the stream-id uniqueness contract (per-encoder vs
      // per-family scoping) rather than namespacing ad hoc here.
      streamId: (c) => `${c.item_id}:summary:${String(c.summary_index)}`,
      deltaField: 'delta',
      fields: [fItemId, fOutputIndex, fSummaryIndex, fSummaryPart],
      deltaFields: [fItemId, fSummaryIndex],
      // item_id/summary_index ride the re-stamped headers; text is the accumulated
      // stream. (The composite stream id is transport-only, never read here.)
      decodeEnd: ({ accumulated, closingCodecHeaders }) => [
        {
          type: 'response.reasoning_summary_text.done',
          item_id: fItemId.read(closingCodecHeaders) ?? '',
          output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
          summary_index: fSummaryIndex.read(closingCodecHeaders) ?? 0,
          text: accumulated,
          sequence_number: 0,
        },
      ],
    }),

    // --- function-call arguments: the streamed tool-call input ----------------
    // A function_call has no *_part.added opener — its slot is the item's own
    // `arguments`, born with the item — so the stream starts on output_item.added
    // (shared with message/reasoning items; claimed only for a function_call via
    // startWhen, other item types decline to the discrete output_item.added
    // event). The id sits nested at item.id on the start but top-level item_id on
    // the deltas (relocate), so it is derived per phase. The fc item rides the
    // start header (fItem), re-stamped on every append, so the decoder rebuilds
    // item_id / name from it — the reducer never parses the transport stream id.
    stream('function_call_arguments', {
      start: 'response.output_item.added',
      delta: 'response.function_call_arguments.delta',
      end: 'response.function_call_arguments.done',
      startWhen: (c) => c.item.type === 'function_call',
      streamId: (c) => {
        if (c.type !== 'response.output_item.added') return c.item_id;
        const id = c.item.id;
        if (id === undefined) {
          throw new Ably.ErrorInfo(
            'unable to stream function-call arguments; item has no id',
            ErrorCode.InvalidArgument,
            400,
          );
        }
        return id;
      },
      deltaField: 'delta',
      fields: [fItem, fOutputIndex],
      decodeDelta: ({ delta, codecHeaders }) => [
        {
          type: 'response.function_call_arguments.delta',
          item_id: fItem.read(codecHeaders)?.id ?? '',
          output_index: fOutputIndex.read(codecHeaders) ?? 0,
          delta,
          sequence_number: 0,
        },
      ],
      decodeEnd: ({ accumulated, closingCodecHeaders }) => {
        const item = fItem.read(closingCodecHeaders);
        return [
          {
            type: 'response.function_call_arguments.done',
            item_id: item?.id ?? '',
            output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
            arguments: accumulated,
            name: item?.type === 'function_call' ? item.name : '',
            sequence_number: 0,
          },
        ];
      },
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
    // The item is a structured object (a message with content parts, a reasoning
    // item, or a function call), not flat scalars, so it rides whole as JSON wire
    // `data` rather than as header fields. `output_index` / `sequence_number` are
    // dropped: the reducer keys on the item's own id, and Ably serials order the
    // wire, so neither is read on decode or resent to /responses.
    //
    // `output_item.added` is emitted as this discrete event only for message and
    // reasoning items. A function_call's `output_item.added` is instead the START
    // of the `function_call_arguments` stream (claimed via that family's
    // `startWhen`), so it never reaches here. `output_item.done`, by contrast, is
    // discrete for every item type — including a function call, whose authoritative
    // complete item arrives here after its argument stream ends.
    // CAST on decode: the output item rides as JSON wire data (trust boundary).
    event('response.output_item.added', {
      data: { encode: (c) => c.item, decode: (d) => ({ item: d as Responses.ResponseOutputItem }) },
    }),
    event('response.output_item.done', {
      data: { encode: (c) => c.item, decode: (d) => ({ item: d as Responses.ResponseOutputItem }) },
    }),
    // content_part.done closes the part; the reducer folds it to nothing. It is
    // declared (rather than dropped) so the part boundary still round-trips as a
    // discrete event on the wire.
    event('response.content_part.done', {
      fields: [fItemId, fOutputIndex, fContentIndex],
    }),
    // The summary-array twin of content_part.done: it closes a summary part after
    // its reasoning_summary_text stream ends. Likewise folds to nothing and is
    // declared so the boundary round-trips.
    event('response.reasoning_summary_part.done', {
      fields: [fItemId, fOutputIndex, fSummaryIndex],
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

    // --- not modelled → throw (opt-in hosted tools / modalities) --------------
    //
    // TODO(AIT-742): this inventory is exhaustive against openai@6.44.0's
    // ResponseStreamEvent union — revisit on a dep bump. Every event OpenAI
    // streams by default is modelled above (as a stream, a discrete boundary, or
    // lifecycle). The events below appear only once you opt into a hosted tool or
    // modality the codec doesn't support, so they are neither described nor
    // ignored: the encoder's safety net throws on them, which beats silently
    // dropping that content. Add support (a stream / event + reducer arm) when we
    // take each on.
    //  text annotations: response.output_text.annotation.added — citations
    //                    (url / file / container-file / file-path) produced by the
    //                    retrieval tools below, so it only appears alongside them.
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
