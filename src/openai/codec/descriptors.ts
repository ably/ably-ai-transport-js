/**
 * Declarative descriptor tables for the OpenAI Responses codec.
 *
 * Output side:
 * - **Content-part streams.** `response.content_part.added` opens three streamed
 *   groups, differentiated by the added part's type: `output_text` and `refusal`
 *   (on a message) and `reasoning_text` (on a reasoning item). Each fills
 *   `content[content_index]` of its item, so its stream id is
 *   `item_id + content_index` and its decoded delta carries both. A reasoning
 *   model's streamed summary is a fourth group (`reasoning_summary_text`, keyed
 *   `item_id + summary_index`). Each group rebuilds its closing `*.done` from the
 *   accumulated stream text via `end.decode`.
 * - **A server-side function call streams its arguments.** The
 *   `function_call_arguments` group opens on `output_item.added` (matched only
 *   for a `function_call`; message/reasoning items decline to the discrete
 *   `output_item.added` event), carries the item envelope on the start header,
 *   and streams the `arguments` text. The complete item still arrives on the
 *   discrete `output_item.done`, and the call's *result* is the codec's own
 *   `function_call_output` event (see below).
 * - **The response lifecycle events are all dropped.** The terminal events
 *   (`response.completed` / `.incomplete` / `.failed`), the openers (`.created`
 *   / `.in_progress` / `.queued`), and the stream-level `error` carry nothing a
 *   wire consumer reads — run outcome is observed out-of-band via the transport
 *   run-end event. The content-/summary-part close boundaries likewise carry
 *   nothing a consumer's fold needs (each streamed group has its own real
 *   close). The codec `drop`s them all — they encode to nothing and never reach
 *   the wire.
 * - **The table is a total inventory; anything outside it throws.** Every event
 *   the codec expects is transmitted (`event` / `stream`) or deliberately kept
 *   off the wire (`drop`); an event that is neither hits the encoder's safety
 *   net and throws — failing loudly beats silently dropping content. That covers
 *   the events that appear only once you opt into a hosted tool / modality the
 *   codec doesn't support (web / file search, code interpreter, image gen, MCP,
 *   audio, custom tools, and the `output_text` annotations those tools cite).
 *   Agents that enable those surfaces must filter the events out before
 *   publishing. The exhaustive hosted-tool inventory is at the tail of the
 *   table below.
 *
 * Input side: none here. The codec's input direction is a passthrough — any
 * JSON-serialisable body publishes as one discrete `ai-input` message and
 * decodes back verbatim (see the codec assembly in `index.ts`), so the
 * application defines its own input vocabulary.
 *
 * Hosted tools are added by adding entries here; the codec/transport split is
 * unaffected.
 */

import * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';

import type { OutputBuilder, OutputDescriptor } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { DoneItem, ModelledOutputItem, OpenAIOutput, WireDoneContentPart, WireDoneItem } from './events.js';
import { isModelledOutputItem } from './events.js';
import {
  contentSlotStreamId,
  fCallId,
  fContentIndex,
  fItem,
  fItemId,
  fName,
  fOutputIndex,
  fPart,
  fSummaryIndex,
  fSummaryPart,
} from './fields.js';

// Coerce arbitrary wire data to a string, defaulting to empty.
const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

// The shared encode-boundary rejection for an output item type the codec
// doesn't model, thrown identically by `assertModelledOutputItem` and
// `toWireItem` below.
const unsupportedOutputItemType = (type: string): Ably.ErrorInfo =>
  new Ably.ErrorInfo(`unable to publish; unsupported output item type '${type}'`, ErrorCode.InvalidArgument, 400);

/**
 * Assert a raw Responses output item is one the codec models, returning it
 * narrowed. This is the encode-boundary guard: it runs where the agent puts an
 * output item on the wire (`output_item.added` / `.done`), so an item type the
 * codec cannot fold fails loudly at the agent — before publish — rather than
 * reaching subscribers. Mirrors the encoder's undescribed-event safety net one
 * level deeper (event type is described; the item type inside is not inspected
 * there).
 * @param item - The output item to check.
 * @returns The item narrowed to {@link ModelledOutputItem}.
 * @throws Ably.ErrorInfo if the item type is not modelled.
 */
const assertModelledOutputItem = (item: Responses.ResponseOutputItem): ModelledOutputItem => {
  if (isModelledOutputItem(item)) return item;
  throw unsupportedOutputItemType(item.type);
};

// An output_text part that actually has logprobs (a request-time opt-in).
interface PartWithLogprobs {
  type: 'output_text';
  logprobs: NonNullable<Responses.ResponseOutputText['logprobs']>;
}
const hasLogprobs = (p: WireDoneContentPart): p is PartWithLogprobs =>
  p.type === 'output_text' && p.logprobs !== undefined && p.logprobs.length > 0;

// Build the `content` array a message's wire-form output_item.done carries. Its
// sole job is to carry per-part `logprobs` to the client, where a consumer
// folds each part's logprobs into its already-streamed content slot by index.
//
// Returns `undefined` when no part has logprobs: there is nothing to carry, so
// the caller omits `content` altogether and the done item stays the lean
// `{ id, type, status }`. Otherwise returns an entry for EVERY part, in order,
// to keep the array index-aligned with the message content: the logprobs where
// present, a bare `{ type }` index placeholder elsewhere.
const toWireContent = (content: readonly WireDoneContentPart[] | undefined): WireDoneContentPart[] | undefined => {
  if (!content?.some((p) => hasLogprobs(p))) return undefined;
  return content.map((p) => (hasLogprobs(p) ? { type: 'output_text', logprobs: p.logprobs } : { type: p.type }));
};

/**
 * Reduce a completed output item to its {@link WireDoneItem} wire shape. The
 * wire form is deliberately lean: OpenAI's real `output_item.done` repeats the
 * item's full content, which the stream deltas already carried, so the codec
 * drops that content and keeps only the fields the client cannot rebuild from
 * the deltas (`id`/`status`, a reasoning item's `encrypted_content`, and a
 * message's per-part `logprobs`). This keeps the streamed content from going on
 * the wire twice; a consumer's fold merges the deltas back into the finalised
 * item.
 * Takes {@link DoneItem} — the real, rich `Responses.ResponseOutputItem`
 * OpenAI actually sends for an unsupported type, or the already-modelled
 * (full or reduced) shape for the three the codec supports, matching what
 * `OpenAIOutput` declares for this event on encode. Reads only the wire-form
 * fields (`id`/`status`, a reasoning item's `encrypted_content`, and a message's
 * per-part `logprobs` — see {@link toWireContent}). Throws if `.type`
 * isn't one the codec models, mirroring {@link assertModelledOutputItem}'s
 * encode-boundary guard one level up.
 * @param item - The completed output item.
 * @returns The wire-form shape carried on `output_item.done`.
 * @throws Ably.ErrorInfo if the item type is not modelled.
 */
const toWireItem = (item: DoneItem): WireDoneItem => {
  if (item.type === 'message') {
    const content = toWireContent(item.content);
    return content === undefined
      ? { type: 'message', id: item.id, status: item.status }
      : { type: 'message', id: item.id, status: item.status, content };
  }
  if (item.type === 'function_call') return { type: 'function_call', id: item.id, status: item.status };
  if (item.type === 'reasoning') {
    const wire: WireDoneItem = { type: 'reasoning', id: item.id, status: item.status };
    if (typeof item.encrypted_content === 'string') wire.encrypted_content = item.encrypted_content;
    return wire;
  }
  throw unsupportedOutputItemType(item.type);
};

/**
 * The OpenAI codec's `ai-output` descriptor table.
 * @param builder - The `{ event, stream, drop }` builder curried on {@link OpenAIOutput}.
 * @param builder.event - Declare a discrete output event.
 * @param builder.stream - Declare a streamed output group.
 * @param builder.drop - Declare an output type deliberately kept off the wire.
 * @returns The output descriptor table.
 */
export const outputs = ({
  event,
  stream,
  drop,
}: OutputBuilder<OpenAIOutput>): readonly OutputDescriptor<OpenAIOutput>[] => [
  // --- content-part streams: assistant text, refusal, reasoning text -------
  // Three groups share the content_part.added start, differentiated by the
  // added part's type; each fills content[content_index] of its item, so the stream id
  // composes item_id + content_index and the decoded delta carries both for a
  // consumer's fold to target the exact slot.
  stream('output_text', {
    streamId: contentSlotStreamId,
    fields: [fItemId, fOutputIndex, fContentIndex, fPart],
    start: {
      type: 'response.content_part.added',
      match: (c) => c.part.type === 'output_text',
    },
    delta: {
      type: 'response.output_text.delta',
      field: 'delta',
      decode: ({ rebuild }) => rebuild([fItemId, fContentIndex]),
    },
    end: {
      type: 'response.output_text.done',
      decode: ({ accumulated, closingCodecHeaders }) => [
        {
          type: 'response.output_text.done',
          item_id: fItemId.read(closingCodecHeaders) ?? '',
          output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
          content_index: fContentIndex.read(closingCodecHeaders) ?? 0,
          text: accumulated,
          // No `logprobs` here: the reconstructed event type strips the field (see
          // WithoutTextDoneLogprobs in events.ts). OpenAI does populate logprobs on
          // the real output_text.done, but the codec sources them from the
          // finalised item instead (output_item.done, whose content is typed
          // `ResponseOutputText` — the rich shape — so the fold is cast-free; see
          // toWireItem).
        },
      ],
    },
  }),

  stream('refusal', {
    streamId: contentSlotStreamId,
    fields: [fItemId, fOutputIndex, fContentIndex, fPart],
    start: {
      type: 'response.content_part.added',
      match: (c) => c.part.type === 'refusal',
    },
    delta: {
      type: 'response.refusal.delta',
      field: 'delta',
      decode: ({ rebuild }) => rebuild([fItemId, fContentIndex]),
    },
    end: {
      type: 'response.refusal.done',
      decode: ({ accumulated, closingCodecHeaders }) => [
        {
          type: 'response.refusal.done',
          item_id: fItemId.read(closingCodecHeaders) ?? '',
          output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
          content_index: fContentIndex.read(closingCodecHeaders) ?? 0,
          refusal: accumulated,
        },
      ],
    },
  }),

  stream('reasoning_text', {
    streamId: contentSlotStreamId,
    fields: [fItemId, fOutputIndex, fContentIndex, fPart],
    start: { type: 'response.content_part.added', match: (c) => c.part.type === 'reasoning_text' },
    delta: {
      type: 'response.reasoning_text.delta',
      field: 'delta',
      decode: ({ rebuild }) => rebuild([fItemId, fContentIndex]),
    },
    end: {
      type: 'response.reasoning_text.done',
      decode: ({ accumulated, closingCodecHeaders }) => [
        {
          type: 'response.reasoning_text.done',
          item_id: fItemId.read(closingCodecHeaders) ?? '',
          output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
          content_index: fContentIndex.read(closingCodecHeaders) ?? 0,
          text: accumulated,
        },
      ],
    },
  }),

  // --- reasoning summary text: a reasoning model's streamed "thinking" ------
  // Each reasoning item emits one or more summary parts, all sharing item_id
  // and distinguished by summary_index — so the stream id is composed from the
  // two. The reasoning item itself is carried on the output_item envelopes;
  // this stream fills its summary[summary_index].text.
  //
  // Provoking summary events (non-obvious) for testing against a real model:
  // the /responses request must opt in with `reasoning: { summary: 'auto' }`
  // (off by default — the demo doesn't set it), AND the prompt must make the
  // model actually reason — a trivial prompt yields ~0 reasoning tokens and an
  // empty summary. Reliable repro against gpt-5.5: the 12-ball weighing puzzle
  // ("12 balls, one a different weight; find it and whether it's heavier or
  // lighter in exactly 3 weighings").
  stream('reasoning_summary_text', {
    // A reasoning item has two indexed dimensions — summary[] and content[]
    // (reasoning_text) — both 0-based, so the summary stream id is namespaced
    // to avoid clashing with a reasoning_text content slot on the same item.
    streamId: (c) => `${c.item_id}:summary:${String(c.summary_index)}`,
    fields: [fItemId, fOutputIndex, fSummaryIndex, fSummaryPart],
    start: { type: 'response.reasoning_summary_part.added' },
    delta: {
      type: 'response.reasoning_summary_text.delta',
      field: 'delta',
      decode: ({ rebuild }) => rebuild([fItemId, fSummaryIndex]),
    },
    // item_id/summary_index are carried on the re-stamped headers; text is the
    // accumulated stream. (The composite stream id is transport-only, never read here.)
    end: {
      type: 'response.reasoning_summary_text.done',
      decode: ({ accumulated, closingCodecHeaders }) => [
        {
          type: 'response.reasoning_summary_text.done',
          item_id: fItemId.read(closingCodecHeaders) ?? '',
          output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
          summary_index: fSummaryIndex.read(closingCodecHeaders) ?? 0,
          text: accumulated,
        },
      ],
    },
  }),

  // --- function-call arguments: the streamed tool-call input ----------------
  // A function_call has no *_part.added opener — its slot is the item's own
  // `arguments`, born with the item — so the stream starts on output_item.added
  // (shared with message/reasoning items; matched only for a function_call via
  // start.match, other item types decline to the discrete output_item.added
  // event). The id sits nested at item.id on the start but top-level item_id on
  // the deltas (relocate), so it is derived per phase. The fc item is carried on
  // the start header (fItem), re-stamped on every append, so the decoder rebuilds
  // item_id / name from it — no consumer ever parses the transport stream id.
  stream('function_call_arguments', {
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
    fields: [fItem, fOutputIndex],
    start: { type: 'response.output_item.added', match: (c) => c.item.type === 'function_call' },
    delta: {
      type: 'response.function_call_arguments.delta',
      field: 'delta',
      decode: ({ delta, codecHeaders }) => [
        {
          type: 'response.function_call_arguments.delta',
          item_id: fItem.read(codecHeaders)?.id ?? '',
          output_index: fOutputIndex.read(codecHeaders) ?? 0,
          delta,
        },
      ],
    },
    end: {
      type: 'response.function_call_arguments.done',
      decode: ({ accumulated, closingCodecHeaders }) => {
        const item = fItem.read(closingCodecHeaders);
        return [
          {
            type: 'response.function_call_arguments.done',
            item_id: item?.id ?? '',
            output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
            arguments: accumulated,
            name: item?.type === 'function_call' ? item.name : '',
          },
        ];
      },
    },
  }),

  // --- response lifecycle (all dropped) -------------------------------------
  // No lifecycle event carries state a wire consumer reads. Run outcome —
  // including failure — is observed out-of-band via the transport run-end event,
  // never folded; the terminal events' Response snapshot would only re-echo the
  // whole reply and the request envelope (instructions, tools, usage, …). The
  // lifecycle openers are that same request envelope, and the stream-level
  // `error` is agent-side signalling, not conversation content. All are dropped:
  // encoded to nothing, never on the wire. (A future agent-side run-outcome
  // mapper — AIT-1113 — would read the terminal events and `error` from the raw
  // stream before encode, so keeping them off the wire costs nothing even once
  // it lands.)
  drop('response.completed'),
  drop('response.incomplete'),
  drop('response.failed'),
  drop('response.created'),
  drop('response.in_progress'),
  drop('response.queued'),
  drop('error'),

  // --- item / content-part envelopes (discrete) ----------------------------
  // The item-carrying discrete events (output_item.added / .done, and the
  // codec's own function_call_output below) publish their item under the `item`
  // key of a JSON wire `data` envelope, consistent with the framework's
  // DataCodec model (see core/codec/fields.ts) and the Vercel codec. The
  // envelope also leaves room for a sibling wire field alongside the item without
  // changing the format. The `item` is a structured object (a message, reasoning
  // item, or function call). The decode CAST below trusts the `{ item }` envelope
  // the encoder always publishes (a trust boundary); it reads `.item` without
  // guarding against a malformed payload, matching the trust a consumer places
  // in the decoded item.
  //
  // `output_index` / `sequence_number` are dropped: the item's own id already
  // identifies it, and Ably serials order the wire, so neither is read on decode
  // or resent to /responses.
  //
  // `output_item.added` is emitted as this discrete event only for message and
  // reasoning items. A function_call's `output_item.added` is instead the START
  // of the `function_call_arguments` stream (matched via that group's
  // `start.match`), so it never reaches here.
  //
  // `output_item.done` is discrete for every item type, but its payload is
  // REDUCED (see {@link toWireItem}): the streams already carried the item's
  // content, so re-echoing the whole item would duplicate (e.g.) a long
  // message's text on the wire. It carries only what finalises the item in a
  // consumer's fold — the terminal `status`; a message's per-part `logprobs`
  // (the one content datum the streamed deltas don't reconstruct — see below);
  // and a reasoning item's done-only `encrypted_content`.
  //
  // Logprobs are sourced from the finalised item here because this is the one
  // place they fold in type-safely. The finalised item's content is typed
  // `ResponseOutputText`, whose `logprobs` is the rich SDK shape (with `bytes`)
  // a folded message's content slot wants, so the fold is a plain, cast-free
  // assignment. The
  // output_text.done EVENT also carries logprobs at runtime, but its SDK type
  // (`ResponseTextDoneEvent`) declares a leaner, `bytes`-less shape, so sourcing
  // them there would need an unsafe cast betting on a richer runtime shape than
  // the type promises. And `content_part.done`, the event that literally hands
  // you the finalised part, does not carry them in practice (its `part.logprobs`
  // comes through empty), so it isn't an option; see its drop below. This
  // mirrors what OpenAI's own reducer does (`accumulateResponse` in
  // openai/lib/responses/ResponseAccumulator — its `output_item.done` case
  // clones the finalised item wholesale): it sources
  // `ResponseOutputText.logprobs` from the finalised item too, not from the
  // per-event logprobs on the deltas or text-done.
  event('response.output_item.added', {
    data: {
      encode: (c) => ({ item: assertModelledOutputItem(c.item) }),
      // CAST: the item is carried under the envelope's `item` key as JSON wire data (trust boundary).
      decode: (d) => ({ item: (d as { item: Responses.ResponseOutputItem }).item }),
    },
  }),
  event('response.output_item.done', {
    data: {
      encode: (c) => ({ item: toWireItem(c.item) }),
      // CAST: the wire envelope carries the WireDoneItem shape under `item` (trust boundary).
      decode: (d) => ({ item: (d as { item: WireDoneItem }).item }),
    },
  }),
  // The content-/summary-part close boundaries are pure markers — each streamed
  // group above already has its own real close (its `end:` chunk —
  // response.output_text.done / .refusal.done / .reasoning_text.done /
  // .reasoning_summary_text.done — rebuilt from the accumulated stream text),
  // so these generic part-close events carry no unique data and are dropped
  // rather than transmitted. Note content_part.done
  // echoes the whole finalised part (text + annotations) and its type even has a
  // `logprobs` field — but OpenAI leaves that field empty in practice (verified
  // against a real response), so it is NOT a viable logprobs carrier; logprobs
  // are carried on output_item.done instead (see above).
  drop('response.content_part.done'),
  drop('response.reasoning_summary_part.done'),

  // --- server-executed tool result (codec's own output event) --------------
  // Not a Responses stream event: OpenAI surfaces tool output only as model
  // input on the next turn, so the agent publishes this after running the
  // tool. A consumer folds the item into the message its codec-message-id
  // names (paired with its function_call by call_id at render time). Like the
  // item envelopes above, the item is carried under the `item` key of its wire
  // `data` envelope (see that note for the rationale).
  event('function_call_output', {
    data: {
      encode: (c) => ({ item: c.item }),
      // CAST: the FunctionCallOutput item is carried under the envelope's `item` key as JSON wire data (trust boundary).
      decode: (d) => ({ item: (d as { item: Responses.ResponseInputItem.FunctionCallOutput }).item }),
    },
  }),

  // --- tool-approval request (codec's own output event) --------------------
  // Not a Responses stream event: OpenAI has no approval concept for plain
  // function calls, so the agent authors this to gate a tool on a human
  // decision (mirroring the Agents SDK's RunToolApprovalItem). call_id and name
  // ride the headers; the tool's arguments ride the JSON wire data, so a client
  // can render the approval prompt from the request alone. A consumer's fold
  // marks the call `pending` in the message's per-call_id tool-call state.
  event('tool-approval-request', {
    fields: [fCallId, fName],
    data: { encode: (c) => c.arguments, decode: (d) => ({ arguments: asString(d) }) },
  }),

  // --- not described → throw (opt-in hosted tools / modalities) -------------
  //
  // The content-bearing events are described above (streams, item envelopes,
  // terminal signals); the framing events are dropped above. The events below
  // appear only once you opt into a hosted tool or modality the codec doesn't
  // support, so they are not described: the encoder's safety net throws on them,
  // which beats silently dropping that content.
  // TODO(AIT-1121): support these event types — each is added by extending this
  // table with a stream / event descriptor. The inventory
  // below is exhaustive against openai@6.44.0's ResponseStreamEvent union;
  // revisit it on a dependency bump.
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
