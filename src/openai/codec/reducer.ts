/**
 * OpenAI Responses reducer.
 *
 * Pure `(init, fold, getMessages)` over the `OpenAIInput | OpenAIOutput`
 * union. Folds the agent's Responses event stream — and the client's
 * user-message turn — into a per-node projection of OpenAI items, exposed as
 * one {@link OpenAITurn} per node.
 *
 * The fold is a mirror of OpenAI's own stream reduction
 * (`openai/lib/responses/ResponseAccumulator`), re-keyed on **`item_id`**
 * rather than the SDK's positional `output_index`. The codec's wire stream
 * model strips a streamed delta down to its stream id plus the appended text,
 * so `output_index` is not available on a decoded delta — but the stream id is,
 * and it equals `item_id`. Keying on `item_id` is the codec-side adaptation
 * that lets the same reduction run on the decoded stream; the logic is
 * otherwise identical to the SDK's.
 *
 * This handles streamed assistant text, refusals, a reasoning model's streamed
 * summary and raw reasoning text, and server-side function calls: the
 * `output_item` message/function-call/reasoning envelope, the content-part
 * streams (`output_text` / `refusal` on the message, `reasoning_text` on the
 * reasoning item — each keyed by `content_index`), the `reasoning_summary_text`
 * stream (folded into the reasoning item's `summary`), the
 * `function_call_arguments` stream (folded into the function-call item's
 * `arguments`), and the codec's own `function_call_output` event.
 * Response-lifecycle and stream-`error` events fold to nothing (run outcome is
 * observed out-of-band). Hosted tools are added later by extending this dispatch.
 *
 * The reducer is stateless and folds unconditionally — the transport delivers
 * each event once, in canonical order (see the core `Reducer` contract).
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { CodecEvent, CodecMessage, ReducerMeta } from '../../core/codec/index.js';
import type { OpenAIInput, OpenAIItem, OpenAIOutput, OpenAITurn } from './events.js';

/** Per-node projection: one turn's items, accumulated, indexed by item id. */
export interface OpenAIProjection {
  /** Whether this node is a user prompt or an assistant reply. */
  role: 'user' | 'assistant';
  /** The turn's items, in the order they were folded. */
  items: OpenAIItem[];
  /** Maps an output item's id to the live (mutable) item in {@link items}, for delta accumulation. */
  byItemId: Map<string, Responses.ResponseOutputItem>;
  /** The codec-message-id this projection's messages are emitted under. */
  codecMessageId: string;
}

/**
 * Build an empty projection for a node.
 * @returns A fresh, empty {@link OpenAIProjection}.
 */
export const init = (): OpenAIProjection => ({
  role: 'assistant',
  items: [],
  byItemId: new Map(),
  codecMessageId: '',
});

const isOutputMessage = (item: Responses.ResponseOutputItem | undefined): item is Responses.ResponseOutputMessage =>
  item?.type === 'message';

const isReasoningItem = (item: Responses.ResponseOutputItem | undefined): item is Responses.ResponseReasoningItem =>
  item?.type === 'reasoning';

const isFunctionCall = (item: Responses.ResponseOutputItem | undefined): item is Responses.ResponseFunctionToolCall =>
  item?.type === 'function_call';

/**
 * Return the reasoning item's summary part at `index`, growing the `summary`
 * array with empty parts up to it if needed. The reasoning summary streams as
 * one or more indexed parts sharing the item; the stream targets `summary[index]`.
 * @param item - The reasoning item to read or extend.
 * @param index - The `summary_index` the streamed part fills.
 * @returns The summary part to write text into.
 */
const summaryAt = (item: Responses.ResponseReasoningItem, index: number): Responses.ResponseReasoningItem.Summary => {
  for (let i = item.summary.length; i <= index; i++) {
    item.summary.push({ type: 'summary_text', text: '' });
  }
  // The loop guarantees index is in range; `?? …` narrows off the array's
  // `T | undefined` index type without a non-null assertion.
  const part = item.summary[index] ?? { type: 'summary_text', text: '' };
  item.summary[index] = part;
  return part;
};

/**
 * Return the message's `output_text` part at `content[index]`, creating it in
 * place if the slot is absent or holds a different part type. Content parts
 * arrive in `content_index` order (each opened by its `content_part.added`), so
 * the slot is either present or the next one.
 * @param message - The output message to read or extend.
 * @param index - The `content_index` the streamed part fills.
 * @returns The `output_text` part to write delta text into.
 */
const outputTextAt = (message: Responses.ResponseOutputMessage, index: number): Responses.ResponseOutputText => {
  const existing = message.content[index];
  if (existing?.type === 'output_text') return existing;
  const part: Responses.ResponseOutputText = { type: 'output_text', text: '', annotations: [] };
  message.content[index] = part;
  return part;
};

/**
 * Return the message's `refusal` part at `content[index]`, creating it in place
 * if absent or a different part type.
 * @param message - The output message to read or extend.
 * @param index - The `content_index` the refusal fills.
 * @returns The `refusal` part to write text into.
 */
const refusalAt = (message: Responses.ResponseOutputMessage, index: number): Responses.ResponseOutputRefusal => {
  const existing = message.content[index];
  if (existing?.type === 'refusal') return existing;
  const part: Responses.ResponseOutputRefusal = { type: 'refusal', refusal: '' };
  message.content[index] = part;
  return part;
};

/**
 * Return the reasoning item's `reasoning_text` part at `content[index]`,
 * creating the `content` array and/or the slot if absent.
 * @param item - The reasoning item to read or extend.
 * @param index - The `content_index` the reasoning text fills.
 * @returns The reasoning-text part to write text into.
 */
const reasoningTextAt = (
  item: Responses.ResponseReasoningItem,
  index: number,
): Responses.ResponseReasoningItem.Content => {
  const content = (item.content ??= []);
  const existing = content[index];
  if (existing?.type === 'reasoning_text') return existing;
  const part: Responses.ResponseReasoningItem.Content = { type: 'reasoning_text', text: '' };
  content[index] = part;
  return part;
};

/**
 * Fold one agent output event into the projection.
 * @param state - Projection to mutate.
 * @param event - The Responses stream event.
 */
const foldOutput = (state: OpenAIProjection, event: OpenAIOutput): void => {
  switch (event.type) {
    case 'response.output_item.added': {
      // TODO(AIT-742): make this find-or-create by item id (as the Vercel reducer's
      // `ensureMessage` does) rather than an unconditional push. The decode-lifecycle
      // mid-stream-join repair can legitimately yield two `output_item.added` events
      // for one id — a synthesised owner plus the real one — when they arrive in the
      // reverse order (join mid-stream, then paginate history back across the
      // envelope); this push then produces a duplicate item. A find-or-create absorbs
      // it (like Vercel) and would let the decode-lifecycle seen-set / `onDiscrete`
      // tracking and the `LifecycleDiscreteContext.data` core addition be removed.
      // Parked pending broader PR direction — see notes/openai-codec-build-log.md.
      const item = structuredClone(event.item);
      state.items.push(item);
      if (item.id !== undefined) state.byItemId.set(item.id, item);
      return;
    }
    case 'response.output_item.done': {
      const item = structuredClone(event.item);
      // Replace the in-progress item if we have it; otherwise append. An item
      // without an id (or one never `added`) simply appends.
      const previous = item.id === undefined ? undefined : state.byItemId.get(item.id);
      const index = previous === undefined ? -1 : state.items.indexOf(previous);
      if (index >= 0) state.items[index] = item;
      else state.items.push(item);
      if (item.id !== undefined) state.byItemId.set(item.id, item);
      return;
    }
    case 'response.content_part.added': {
      const item = state.byItemId.get(event.item_id);
      const part = event.part;
      // Seed the slot at content_index with the added part: text/refusal parts
      // on a message, reasoning-text parts on a reasoning item.
      if (isOutputMessage(item) && (part.type === 'output_text' || part.type === 'refusal')) {
        item.content[event.content_index] = structuredClone(part);
      } else if (isReasoningItem(item) && part.type === 'reasoning_text') {
        (item.content ??= [])[event.content_index] = structuredClone(part);
      }
      return;
    }
    case 'response.output_text.delta': {
      const item = state.byItemId.get(event.item_id);
      if (isOutputMessage(item)) outputTextAt(item, event.content_index).text += event.delta;
      return;
    }
    case 'response.output_text.done': {
      const item = state.byItemId.get(event.item_id);
      if (isOutputMessage(item)) outputTextAt(item, event.content_index).text = event.text;
      return;
    }
    case 'response.refusal.delta': {
      const item = state.byItemId.get(event.item_id);
      if (isOutputMessage(item)) refusalAt(item, event.content_index).refusal += event.delta;
      return;
    }
    case 'response.refusal.done': {
      const item = state.byItemId.get(event.item_id);
      if (isOutputMessage(item)) refusalAt(item, event.content_index).refusal = event.refusal;
      return;
    }
    case 'response.reasoning_text.delta': {
      const item = state.byItemId.get(event.item_id);
      if (isReasoningItem(item)) reasoningTextAt(item, event.content_index).text += event.delta;
      return;
    }
    case 'response.reasoning_text.done': {
      const item = state.byItemId.get(event.item_id);
      if (isReasoningItem(item)) reasoningTextAt(item, event.content_index).text = event.text;
      return;
    }
    case 'response.reasoning_summary_part.added': {
      const item = state.byItemId.get(event.item_id);
      if (isReasoningItem(item)) summaryAt(item, event.summary_index).text = event.part.text;
      return;
    }
    case 'response.reasoning_summary_text.delta': {
      const item = state.byItemId.get(event.item_id);
      if (isReasoningItem(item)) summaryAt(item, event.summary_index).text += event.delta;
      return;
    }
    case 'response.reasoning_summary_text.done': {
      const item = state.byItemId.get(event.item_id);
      if (isReasoningItem(item)) summaryAt(item, event.summary_index).text = event.text;
      return;
    }
    case 'response.function_call_arguments.delta': {
      const item = state.byItemId.get(event.item_id);
      if (isFunctionCall(item)) item.arguments += event.delta;
      return;
    }
    case 'response.function_call_arguments.done': {
      const item = state.byItemId.get(event.item_id);
      // The complete arguments; the authoritative item also arrives on
      // output_item.done, which replaces the whole item.
      if (isFunctionCall(item)) item.arguments = event.arguments;
      return;
    }
    case 'function_call_output': {
      // The server-executed tool's result. Append it to the turn so it sits
      // beside its function_call (paired by call_id when rendered and when fed
      // back to /responses). Function calls themselves fold via the
      // output_item arms above — a function_call is a ResponseOutputItem.
      state.items.push(structuredClone(event.item));
      return;
    }
    default: {
      // Everything else folds to nothing. The response lifecycle
      // (created/completed/failed) and the stream-level `error` carry no item
      // state the reducer needs: run termination — including failure — is
      // observed out-of-band via the transport run-end event, never folded into
      // items. The content-part / summary-part `*.done` boundaries are dropped
      // (their text is folded from the streams); hosted tools are not modelled yet.
      // TODO(AIT-742): a run-outcome mapper will read response.failed / `error`.
      return;
    }
  }
};

/**
 * Whether an item is an input message (the shape a user turn carries). Within
 * the user-message fold every item is an input message the codec constructed,
 * so the narrowing to {@link Responses.ResponseInputItem.Message} is sound here
 * even though an output message would also satisfy `type === 'message'`.
 * @param item - The item to test.
 * @returns Whether to treat `item` as an input message.
 */
const isInputMessage = (item: OpenAIItem): item is Responses.ResponseInputItem.Message =>
  item.type === 'message' && Array.isArray(item.content);

/**
 * Fold a user-message turn into the projection. The input wire delivers one
 * event per content part, so each fold merges its part(s) into the turn's
 * single input message — appending to the existing message item if present,
 * else seeding it. This keeps the optimistic (whole-message) fold and the
 * per-part wire refold converging on the same turn.
 * @param state - Projection to mutate.
 * @param turn - The user turn (one input message, one or more content parts).
 */
const foldUserMessage = (state: OpenAIProjection, turn: OpenAITurn): void => {
  // Use the turn's own role (carried on the wire role header) rather than
  // forcing 'user', so the role round-trips faithfully. For the user-message
  // input it is 'user' in practice.
  state.role = turn.role;
  // Assumption in use here: a user turn is a single input message, so every
  // incoming part merges into the one message item — resolved once, seeded on
  // first contact, appended thereafter.
  let target = state.items.find(isInputMessage);
  for (const incoming of turn.items) {
    if (!isInputMessage(incoming)) continue;
    if (target) {
      target.content.push(...incoming.content);
    } else {
      target = structuredClone(incoming);
      state.items.push(target);
    }
  }
};

/**
 * Fold one direction-tagged input or output event into the projection.
 * @param state - Projection to fold into (mutated in place and returned).
 * @param event - The direction-tagged input or output event.
 * @param meta - Transport-derived metadata (serial, optional codec-message-id).
 * @returns The same projection reference.
 */
export const fold = (
  state: OpenAIProjection,
  event: CodecEvent<OpenAIInput, OpenAIOutput>,
  meta: ReducerMeta,
): OpenAIProjection => {
  if (meta.messageId !== undefined) state.codecMessageId = meta.messageId;

  if (event.direction === 'output') {
    foldOutput(state, event.event);
  } else if (event.event.kind === 'user-message') {
    foldUserMessage(state, event.event.message);
  }
  // The only other input variant is `regenerate` — a wire-only signal that
  // decodes to nothing and so never reaches the reducer; it carries no
  // projection state. Tool results and approvals (with their own dispatch)
  // arrive in later increments.
  return state;
};

/**
 * Extract the turn for this projection, paired with its codec-message-id.
 * @param projection - A projection produced by `init` + repeated `fold`.
 * @returns A single-element list (the turn), or empty when nothing has folded.
 */
export const getMessages = (projection: OpenAIProjection): CodecMessage<OpenAITurn>[] => {
  if (projection.items.length === 0) return [];
  return [{ codecMessageId: projection.codecMessageId, message: { role: projection.role, items: projection.items } }];
};
