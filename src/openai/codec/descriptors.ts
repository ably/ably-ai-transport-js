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
 * - **The terminal lifecycle events are bare discrete signals** (`response.completed`
 *   / `.incomplete` / `.failed`) — no payload. They carry only the signal the
 *   decode-lifecycle policy needs to free its owner-tracking; run outcome is
 *   observed out-of-band. The lifecycle openers (`created` / `.in_progress` /
 *   `.queued`), the stream-level `error`, and the content-/summary-part close
 *   boundaries carry nothing the projection needs, so the codec `drop`s them —
 *   they encode to nothing and never reach the wire.
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
import type {
  DoneItem,
  ModelledOutputItem,
  OpenAIInput,
  OpenAIOutput,
  OpenAITurn,
  SlimDoneContentPart,
  SlimDoneItem,
} from './events.js';
import { isModelledOutputItem } from './events.js';
import {
  contentSlotStreamId,
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

// The shared encode-boundary rejection for an output item type the codec
// doesn't model, thrown identically by `assertModelledOutputItem` and
// `slimDoneItem` below.
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
const hasLogprobs = (p: SlimDoneContentPart): p is PartWithLogprobs =>
  p.type === 'output_text' && p.logprobs !== undefined && p.logprobs.length > 0;

// Build the `content` array a message's slimmed output_item.done carries. Its
// sole job is to carry per-part `logprobs` to the client, where the reducer
// folds each part's logprobs into its already-streamed content slot by index.
//
// Returns `undefined` when no part has logprobs: there is nothing to carry, so
// the caller omits `content` altogether and the done item stays the lean
// `{ id, type, status }`. Otherwise returns an entry for EVERY part, in order,
// to keep the array index-aligned with the message content: the logprobs where
// present, a bare `{ type }` index placeholder elsewhere.
const slimMessageContent = (content: readonly SlimDoneContentPart[] | undefined): SlimDoneContentPart[] | undefined => {
  if (!content?.some((p) => hasLogprobs(p))) return undefined;
  return content.map((p) => (hasLogprobs(p) ? { type: 'output_text', logprobs: p.logprobs } : { type: p.type }));
};

/**
 * Reduce a completed output item to its {@link SlimDoneItem} wire shape.
 * Takes {@link DoneItem} — the real, rich `Responses.ResponseOutputItem`
 * OpenAI actually sends for an unsupported type, or the already-modelled
 * (full or slim) shape for the three the codec supports, matching what
 * `OpenAIOutput` declares for this event on encode. Reads only the slim fields
 * (`id`/`status`, a reasoning item's `encrypted_content`, and a message's
 * per-part `logprobs` — see {@link slimMessageContent}). Throws if `.type`
 * isn't one the codec models, mirroring {@link assertModelledOutputItem}'s
 * encode-boundary guard one level up.
 * @param item - The completed output item.
 * @returns The slim wire shape carried on `output_item.done`.
 * @throws Ably.ErrorInfo if the item type is not modelled.
 */
const slimDoneItem = (item: DoneItem): SlimDoneItem => {
  if (item.type === 'message') {
    const content = slimMessageContent(item.content);
    return content === undefined
      ? { type: 'message', id: item.id, status: item.status }
      : { type: 'message', id: item.id, status: item.status, content };
  }
  if (item.type === 'function_call') return { type: 'function_call', id: item.id, status: item.status };
  if (item.type === 'reasoning') {
    const slim: SlimDoneItem = { type: 'reasoning', id: item.id, status: item.status };
    if (typeof item.encrypted_content === 'string') slim.encrypted_content = item.encrypted_content;
    return slim;
  }
  throw unsupportedOutputItemType(item.type);
};

/**
 * The OpenAI codec's `ai-output` descriptor table.
 * @param builder - The `{ event, stream, drop }` builder curried on {@link OpenAIOutput}.
 * @param builder.event - Declare a discrete output event.
 * @param builder.stream - Declare a streamed output family.
 * @param builder.drop - Declare an output type deliberately kept off the wire.
 * @returns The output descriptor table.
 */
export const outputs = ({
  event,
  stream,
  drop,
}: OutputBuilder<OpenAIOutput>): readonly OutputDescriptor<OpenAIOutput>[] => [
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
    streamId: contentSlotStreamId,
    deltaField: 'delta',
    fields: [fItemId, fOutputIndex, fContentIndex, fPart],
    decodeDelta: ({ rebuild }) => rebuild([fItemId, fContentIndex]),
    decodeEnd: ({ accumulated, closingCodecHeaders }) => [
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
        // slimDoneItem). Reconstructing them here would mean either an unsafe
        // cast (the streamed event's SDK type is leaner, `bytes`-less) or
        // fabricating an empty `[]`; stripping the field avoids both.
      },
    ],
  }),

  stream('refusal', {
    start: 'response.content_part.added',
    delta: 'response.refusal.delta',
    end: 'response.refusal.done',
    startWhen: (c) => c.part.type === 'refusal',
    streamId: contentSlotStreamId,
    deltaField: 'delta',
    fields: [fItemId, fOutputIndex, fContentIndex, fPart],
    decodeDelta: ({ rebuild }) => rebuild([fItemId, fContentIndex]),
    decodeEnd: ({ accumulated, closingCodecHeaders }) => [
      {
        type: 'response.refusal.done',
        item_id: fItemId.read(closingCodecHeaders) ?? '',
        output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
        content_index: fContentIndex.read(closingCodecHeaders) ?? 0,
        refusal: accumulated,
      },
    ],
  }),

  stream('reasoning_text', {
    start: 'response.content_part.added',
    delta: 'response.reasoning_text.delta',
    end: 'response.reasoning_text.done',
    startWhen: (c) => c.part.type === 'reasoning_text',
    streamId: contentSlotStreamId,
    deltaField: 'delta',
    fields: [fItemId, fOutputIndex, fContentIndex, fPart],
    decodeDelta: ({ rebuild }) => rebuild([fItemId, fContentIndex]),
    decodeEnd: ({ accumulated, closingCodecHeaders }) => [
      {
        type: 'response.reasoning_text.done',
        item_id: fItemId.read(closingCodecHeaders) ?? '',
        output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
        content_index: fContentIndex.read(closingCodecHeaders) ?? 0,
        text: accumulated,
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
    // TODO(AIT-1117): decide the stream-id uniqueness contract (per-encoder vs
    // per-family scoping) rather than namespacing ad hoc here.
    streamId: (c) => `${c.item_id}:summary:${String(c.summary_index)}`,
    deltaField: 'delta',
    fields: [fItemId, fOutputIndex, fSummaryIndex, fSummaryPart],
    decodeDelta: ({ rebuild }) => rebuild([fItemId, fSummaryIndex]),
    // item_id/summary_index ride the re-stamped headers; text is the accumulated
    // stream. (The composite stream id is transport-only, never read here.)
    decodeEnd: ({ accumulated, closingCodecHeaders }) => [
      {
        type: 'response.reasoning_summary_text.done',
        item_id: fItemId.read(closingCodecHeaders) ?? '',
        output_index: fOutputIndex.read(closingCodecHeaders) ?? 0,
        summary_index: fSummaryIndex.read(closingCodecHeaders) ?? 0,
        text: accumulated,
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
        },
      ];
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
  // mapper — see the reducer's AIT-1113 note — would read the terminal events and
  // `error` from the raw stream before encode, so keeping them off the wire costs
  // nothing even once it lands.)
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
  // guarding against a malformed payload, matching the trust the reducer already
  // places in the decoded item.
  //
  // `output_index` / `sequence_number` are dropped: the reducer keys on the
  // item's own id, and Ably serials order the wire, so neither is read on decode
  // or resent to /responses.
  //
  // `output_item.added` is emitted as this discrete event only for message and
  // reasoning items. A function_call's `output_item.added` is instead the START
  // of the `function_call_arguments` stream (claimed via that family's
  // `startWhen`), so it never reaches here.
  //
  // `output_item.done` is discrete for every item type, but its payload is
  // SLIMMED (see {@link slimDoneItem}): the item's content is already folded from
  // the streams, so re-echoing the whole item would duplicate (e.g.) a long
  // message's text on the wire. It carries only what the reducer finalises — the
  // terminal `status`; a message's per-part `logprobs` (the one content datum
  // the streamed deltas don't reconstruct — see below); and a reasoning item's
  // done-only `encrypted_content`.
  //
  // Why logprobs ride HERE and not the streamed output_text.done close: this is
  // the one place they can be folded type-safely. The finalised item's content
  // is typed `ResponseOutputText`, whose `logprobs` is the rich SDK shape (with
  // `bytes`) the projection slot wants, so the fold is a plain, cast-free
  // assignment. The output_text.done EVENT also carries logprobs at runtime, but
  // its SDK type (`ResponseTextDoneEvent`) declares a leaner, `bytes`-less shape,
  // so sourcing them there would need an unsafe cast betting on a richer runtime
  // shape than the type promises. And `content_part.done` — the event that
  // literally hands you the finalised part — does NOT carry them in practice
  // (its `part.logprobs` comes through empty, surprising as that is), so it
  // isn't an option; see its drop below. This mirrors what OpenAI's own response
  // accumulator does (openai/lib/responses/ResponseAccumulator's
  // `output_item.done` case clones the finalised item wholesale): it sources
  // `ResponseOutputText.logprobs` from the finalised item too, not from the
  // per-event logprobs on the deltas / text-done.
  event('response.output_item.added', {
    data: {
      encode: (c) => ({ item: assertModelledOutputItem(c.item) }),
      // CAST: the item rides under the envelope's `item` key as JSON wire data (trust boundary).
      decode: (d) => ({ item: (d as { item: Responses.ResponseOutputItem }).item }),
    },
  }),
  event('response.output_item.done', {
    data: {
      encode: (c) => ({ item: slimDoneItem(c.item) }),
      // CAST: the wire envelope carries the SlimDoneItem shape under `item` (trust boundary).
      decode: (d) => ({ item: (d as { item: SlimDoneItem }).item }),
    },
  }),
  // The content-/summary-part close boundaries are pure markers the reducer
  // folds to nothing — each streamed family above already has its own real
  // close (its `end:` chunk — response.output_text.done / .refusal.done /
  // .reasoning_text.done / .reasoning_summary_text.done — rebuilt from the
  // accumulated stream text), so these generic part-close events carry no
  // unique data and are dropped rather than transmitted. Note content_part.done
  // echoes the whole finalised part (text + annotations) and its type even has a
  // `logprobs` field — but OpenAI leaves that field empty in practice (verified
  // against a real response), so it is NOT a viable logprobs carrier; logprobs
  // ride output_item.done instead (see above).
  drop('response.content_part.done'),
  drop('response.reasoning_summary_part.done'),

  // --- server-executed tool result (codec's own output event) --------------
  // Not a Responses stream event: OpenAI surfaces tool output only as model
  // input on the next turn, so the agent publishes this after running the
  // tool. The reducer appends the item to the assistant turn alongside the
  // matching function_call. Like the item envelopes above, the item rides under
  // the `item` key of its wire `data` envelope (see that note for the rationale).
  event('function_call_output', {
    data: {
      encode: (c) => ({ item: c.item }),
      // CAST: the FunctionCallOutput item rides under the envelope's `item` key as JSON wire data (trust boundary).
      decode: (d) => ({ item: (d as { item: Responses.ResponseInputItem.FunctionCallOutput }).item }),
    },
  }),

  // --- not described → throw (opt-in hosted tools / modalities) -------------
  //
  // The content-bearing events are described above (streams, item envelopes,
  // terminal signals); the framing events are dropped above. The events below
  // appear only once you opt into a hosted tool or modality the codec doesn't
  // support, so they are not described: the encoder's safety net throws on them,
  // which beats silently dropping that content.
  // TODO(AIT-1121): support these event types — each is added by extending this
  // table with a stream / event descriptor plus its reducer arm. The inventory
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

/**
 * The OpenAI codec's `ai-input` descriptor table.
 *
 * The user message is a `batch`: a user turn is a single input message whose
 * content parts (`input_text`, and when we've done AIT-1120 `input_image` / `input_file`) are
 * fanned out into one `ai-input` event per part, all sharing `kind:
 * user-message` and the turn's codec-message-id, each carrying its `partType`
 * and the turn's `role`. The transport groups the parts into one node by their
 * shared codec-message-id; the reducer then merges them within that node (see
 * the reducer's user-message merge). A turn with no encodable part still emits
 * one empty text part so the message round-trips.
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
      // Precondition: A user-message must have exactly one item, and this
      // item must have type "message". Note that this does not limit the
      // kinds of content that a user is able to send; they can send multiple
      // content parts within this single item.
      //
      // If we wished to support multiple items per user-message (which I
      // can't currently think of a reason we would want to) then we'd need
      // to make the exploded parts carry information on the wire about
      // which item index they belong to. However, then we'd end up in a
      // situation in which the projection would have to accommodate holes
      // in its `items` array whilst all of the items stream in; this is
      // structurally a similar problem to that described in AIT-1160 (see
      // the corresponding comment in the reducer's getMessages() for our
      // OpenAI-specific workaround for the generic problem that issue
      // describes).
      const { items } = input.message;
      const item = items.length === 1 ? items[0] : undefined;
      if (item?.type !== 'message') {
        throw new Ably.ErrorInfo(
          `unable to publish; a user turn must be exactly one message item, got ${String(items.length)} item(s)`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
      const parts: Responses.ResponseInputText[] = [];
      for (const part of item.content) {
        // Precondition: All parts must have type input_text, which is the
        // only part type we currently support.
        // TODO(AIT-1120): add `input_image` and `input_file` parts for richer prompts.
        if (part.type !== 'input_text') {
          throw new Ably.ErrorInfo(
            `unable to publish; unsupported input content part type '${part.type}'`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        parts.push(part);
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
