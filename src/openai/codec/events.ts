/**
 * Type bindings for the OpenAI Responses codec.
 *
 * Binds the `WireCodec` output parameter to OpenAI's Responses types: the
 * codec passes the raw Responses event stream through as `TOutput`. The input
 * direction is a passthrough — the codec accepts any JSON-serialisable input
 * body and carries it opaquely (`TInput = unknown`), so the application
 * defines its own input vocabulary (see the responses-transport demo for a
 * worked one).
 *
 * Hosted tools and additional modalities are added by extending the descriptor
 * table, not by changing these bindings.
 */

import type { Responses } from 'openai/resources/responses/responses';

/**
 * A server-executed tool's result, published by the agent after it runs the
 * tool. This is the one output event the codec adds beyond OpenAI's own stream:
 * a `/responses` stream never carries the function-call *output* — OpenAI
 * surfaces tool output only as model *input* on the next turn — so the codec
 * gives it its own output event. The agent emits it between `/responses` calls
 * in its agentic loop; a consumer folds it into the message
 * named by its codec-message-id. Because each `pipe`/`send` mints a fresh id,
 * an output published on its own `send` lands in its own message, separate from
 * the one holding the `function_call`; a renderer pairs them by `call_id`.
 */
export interface FunctionCallOutputEvent {
  /** Discriminator. Distinct from every `Responses.ResponseStreamEvent` `type`. */
  type: 'function_call_output';
  /** The function-call output item to append to its message. */
  item: Responses.ResponseInputItem.FunctionCallOutput;
}

/**
 * A codec-authored request that a client approve a tool before it runs.
 *
 * The Responses API has no approval concept for plain function calls (only
 * hosted MCP tools carry `mcp_approval_request` items), so this is a codec
 * output event with no OpenAI-stream equivalent, mirroring the OpenAI Agents
 * SDK's `RunToolApprovalItem`. That item exposes `name` / `arguments` getters
 * over the raw `function_call`, so this event carries the same fields — a
 * client can render the approval prompt from the request alone, without having
 * received the streamed `function_call`. A consumer folds it into the
 * per-`call_id` tool-call state of the message its codec-message-id names,
 * marking the call `pending`. The client answers with its own
 * approval-decision input body — inputs are application-defined and the codec
 * carries them opaquely.
 */
export interface ToolApprovalRequestEvent {
  /** Discriminator. Distinct from every `Responses.ResponseStreamEvent` `type` and from `function_call_output`. */
  type: 'tool-approval-request';
  /** The `call_id` of the `function_call` this approval gates. */
  call_id: string;
  /** The tool's name, so a client can render the prompt without the streamed `function_call`. */
  name: string;
  /** The tool's arguments as JSON text, mirroring the `function_call`'s `arguments`. */
  arguments: string;
}

/**
 * The `type` literals of events the *decoder* itself reconstructs rather than
 * ever receiving genuinely from the wire with a real `sequence_number`:
 * - the five streamed groups' `*.done`/`.delta` closes ({@link
 *   import('./descriptors.js').outputs}' `end.decode`/`delta.decode` escape
 *   hatches rebuild these from accumulated stream text and re-stamped
 *   headers, neither of which carries `sequence_number` — nothing on our wire
 *   ever does, since it exists only to order events within a single raw
 *   OpenAI SSE connection, a job Ably's own serials already do for us);
 * - `response.output_item.added` / `.done`: `.added` is also synthesised by
 *   `decode-lifecycle.ts` as a mid-stream-join repair when a client catches a
 *   group's stream without having seen the real opening bracket; both events'
 *   discrete `decode` in `descriptors.ts` only ever produces `{ item }` (no
 *   `fields` is declared for either), so neither ever carried this on decode
 *   in the first place.
 *
 * `Responses.ResponseStreamEvent` declares `sequence_number` as a required
 * `number` on every member, so without this these reconstructions would have
 * to invent a value that looks real but never is. This strips the field from
 * just these members, leaving every other member — which reaches this codec
 * only as genuine agent-published passthrough of the real OpenAI stream,
 * always carrying its real, meaningful `sequence_number` — untouched.
 */
type ReconstructedEventType =
  | 'response.output_text.done'
  | 'response.refusal.done'
  | 'response.reasoning_text.done'
  | 'response.reasoning_summary_text.done'
  | 'response.function_call_arguments.delta'
  | 'response.function_call_arguments.done'
  | 'response.output_item.added'
  | 'response.output_item.done';

/** Distributes over the union, omitting `sequence_number` from just the {@link ReconstructedEventType} members. */
type WithoutSequenceNumber<T> = T extends { type: ReconstructedEventType } ? Omit<T, 'sequence_number'> : T;

/** Distributes `Pick` over a union member-by-member, keeping only the fields that member actually has. */
type PickPresent<T, K extends string> = T extends unknown ? Pick<T, Extract<keyof T, K>> : never;

/**
 * A completed message's content part reduced to the one datum a consumer's fold
 * can't rebuild from the streamed text: an output_text part's `logprobs`. Derived
 * per variant via {@link PickPresent}, so an output_text part keeps `logprobs` at
 * its exact SDK type ({@link Responses.ResponseOutputText}'s — the rich shape,
 * with `bytes`) and a refusal part reduces to just its `type`. Carried
 * index-aligned with the message's `content` so a consumer folds each part
 * into its slot by index.
 */
export type WireDoneContentPart = PickPresent<Responses.ResponseOutputMessage['content'][number], 'type' | 'logprobs'>;

/**
 * The wire-form shape of a completed output item. A real `response.output_item.done`
 * re-echoes the whole item, but the streamed deltas already carried the item's
 * content — so the codec transmits only what finalises the item in a consumer's
 * fold: the terminal `status`; a message's per-part `logprobs` (the sole content
 * datum NOT carried by the streamed deltas — see {@link WireDoneContentPart},
 * present only when logprobs were requested); and a reasoning item's
 * `encrypted_content` (its sole cross-turn carrier of chain-of-thought under
 * `store: false` / ZDR, so it must survive the reduction).
 *
 * Each variant `Pick`s from the real SDK type, so field types and optionality
 * track the SDK exactly (e.g. `message`/`reasoning`'s `id` is required,
 * `function_call`'s isn't; only `reasoning` has `encrypted_content`).
 * Discriminated per item type, so a consumer's `done.type === 'message'` check
 * narrows `done.content` into scope precisely — and because `logprobs` keeps its
 * rich `ResponseOutputText` type, folding it into the message's content slot is a
 * plain assignment with no cast. The `descriptors.ts` `output_item.done`
 * descriptor documents in full why logprobs are sourced from the finalised item
 * (and the OpenAI accumulator that choice mirrors).
 */
export type WireDoneItem =
  | (Pick<Responses.ResponseOutputMessage, 'id' | 'type' | 'status'> & {
      /**
       * The message's content parts reduced to their per-part `logprobs`
       * residue, index-aligned with the item's `content`. Present only when
       * logprobs were requested; omitted otherwise, keeping the lean done item.
       */
      content?: WireDoneContentPart[];
    })
  | Pick<Responses.ResponseFunctionToolCall, 'id' | 'type' | 'status'>
  | Pick<Responses.ResponseReasoningItem, 'id' | 'type' | 'status' | 'encrypted_content'>;

/** The output item types the codec does not model, left at their full SDK shape. */
type UnmodelledOutputItem = Exclude<Responses.ResponseOutputItem, { type: ModelledOutputItem['type'] }>;

/**
 * The type of `response.output_item.done`'s `item`: either a modelled item
 * reduced to {@link WireDoneItem} (the only shapes the codec ever emits — see
 * `toWireItem`), or an {@link UnmodelledOutputItem} at its full, real shape.
 *
 * The unmodelled half exists only for type assignability, not because such
 * items are ever published: `toWireItem` throws on an unmodelled type before
 * publish, but a genuine agent-published event can structurally carry any
 * `ResponseOutputItem` (nothing in OpenAI's SDK types narrows it to what we
 * support), so `DoneItem` must accept them for {@link AssertRealEventIsOpenAIOutput}
 * to hold. Leaving them full rather than reducing them is what keeps that
 * assignment legal — some hosted-tool item types carry `status` literals (e.g.
 * `'searching'`) no modelled variant's `status` allows.
 */
export type DoneItem = WireDoneItem | UnmodelledOutputItem;

/**
 * `response.output_item.done`'s `item` is declared {@link DoneItem}, not the
 * full rich type the SDK gives the event: a genuine agent-published event
 * (any item type) is still assignable, since `DoneItem` only reduces the three
 * item types the decoder ever actually reconstructs and leaves every other
 * type at its real shape. `toWireItem` (`descriptors.ts`) accepts this same
 * type on encode for exactly this reason.
 */
type WithWireDoneItem<T> = T extends { type: 'response.output_item.done' } ? Omit<T, 'item'> & { item: DoneItem } : T;

/**
 * Distributes over the union, omitting `logprobs` from the reconstructed
 * `response.output_text.done`. The codec sources an output_text part's logprobs
 * from the finalised item (see {@link WireDoneItem}), never this streamed close,
 * so the reconstruction genuinely has none and a consumer never reads them
 * here. Stripping the field keeps the `end.decode` reconstruction honest — it
 * reflects what the codec actually carries — rather than fabricating an empty
 * `[]` just to satisfy the SDK's required-field type.
 */
type WithoutTextDoneLogprobs<T> = T extends { type: 'response.output_text.done' } ? Omit<T, 'logprobs'> : T;

/**
 * A `Responses.ResponseStreamEvent` as this codec models it — the three
 * reductions the codec applies, composed: `sequence_number` stripped from the
 * reconstructed events ({@link WithoutSequenceNumber}), `output_item.done`'s
 * `item` reduced ({@link WithWireDoneItem}), and `output_text.done`'s `logprobs`
 * stripped ({@link WithoutTextDoneLogprobs}). Each targets a distinct event
 * type, so the nesting order is immaterial. A real event straight off OpenAI's
 * stream is still assignable — it simply carries real data (a `sequence_number`,
 * a rich `item`, an `output_text.done` `logprobs` array) this shape doesn't
 * require and the codec never reads.
 */
type WireResponseEvent = WithoutTextDoneLogprobs<
  WithWireDoneItem<WithoutSequenceNumber<Responses.ResponseStreamEvent>>
>;

/**
 * `TOutput` — a {@link WireResponseEvent} (the Responses stream events as
 * the codec models them, mirroring how the Vercel codec binds
 * `AI.UIMessageChunk`), plus the codec's own {@link FunctionCallOutputEvent} for
 * server-executed tool results. The agent pipes its stream as-is: the codec's
 * descriptor table curates the wire, transmitting the events a consumer's fold
 * needs, dropping the redundant framing events, and throwing at the encoder on
 * anything undescribed (see the descriptor table's inventory).
 * {@link AssertRealEventIsOpenAIOutput} checks the real-event-assignable claim
 * at compile time. The codec-authored {@link ToolApprovalRequestEvent} is the
 * second such addition, for gating a tool on a human decision.
 */
export type OpenAIOutput = WireResponseEvent | FunctionCallOutputEvent | ToolApprovalRequestEvent;

/** A type-level assertion: `T` must be exactly `true`, or this fails to typecheck. */
type Assert<T extends true> = T;

/**
 * Compile-time-only proof of {@link OpenAIOutput}'s own claim that a genuine
 * `Responses.ResponseStreamEvent` is always assignable to it. Never
 * referenced at runtime — its only job is to fail to typecheck, right here,
 * if a future change to `WithoutSequenceNumber` / `WithWireDoneItem` /
 * `WithoutTextDoneLogprobs` (or an OpenAI SDK bump) ever breaks that claim,
 * instead of surfacing nowhere until someone happens to pipe a real stream
 * through (today, only the `yield value` in the demo's `agent-stream.ts`,
 * which isn't even part of this package's own `tsc` run).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- see doc comment
type AssertRealEventIsOpenAIOutput = Assert<Responses.ResponseStreamEvent extends OpenAIOutput ? true : false>;

/**
 * The output item shapes the codec currently folds from a `/responses` stream:
 * an output message, a reasoning item, and a function call.
 *
 * This is a deliberately small subset of OpenAI's `ResponseOutputItem` union.
 * That union also contains item types whose output shape is not assignable to
 * `ResponseInputItem` — e.g. `computer_call_output` and `additional_tools`,
 * whose output forms carry fields the input variant of the same item rejects (a
 * `'failed'` status, a wider `role`) — so `ResponseOutputItem` cannot be fed
 * back to the model wholesale. Every member of the set below, by contrast, is
 * itself a member of `ResponseInputItem`, so the items we store round-trip to
 * `/responses` untouched. The set grows as we add support for further streamed
 * item types.
 *
 * The encoder rejects any output item outside this set (see the output
 * descriptor table's `assertModelledOutputItem`), so an undescribed item type
 * fails loudly at the agent — before publish — rather than corrupting a turn.
 */
export type ModelledOutputItem =
  | Responses.ResponseOutputMessage
  | Responses.ResponseReasoningItem
  | Responses.ResponseFunctionToolCall;

/**
 * Whether a raw Responses output item is one the codec models.
 * @param item - The output item to test.
 * @returns Whether `item` is a {@link ModelledOutputItem}.
 */
export const isModelledOutputItem = (item: Responses.ResponseOutputItem): item is ModelledOutputItem =>
  item.type === 'message' || item.type === 'reasoning' || item.type === 'function_call';
