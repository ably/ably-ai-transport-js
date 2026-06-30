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
 * This increment handles streamed assistant text only: the `output_item`
 * message envelope, the `content_part` boundary, and `output_text` deltas.
 * Response-lifecycle and stream-`error` events fold to nothing (run outcome is
 * observed out-of-band). Function calls, reasoning, refusals, and hosted tools
 * are added later by extending this dispatch.
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

/**
 * Return the message item's trailing `output_text` part, creating one if the
 * latest part is not already an `output_text` part. This increment assumes a
 * single text part per message; keying on `content_index` would generalise this.
 * @param message - The output message to read or extend.
 * @returns The `output_text` part to append delta text into.
 */
const trailingOutputText = (message: Responses.ResponseOutputMessage): Responses.ResponseOutputText => {
  const tail = message.content.at(-1);
  if (tail?.type === 'output_text') return tail;
  const part: Responses.ResponseOutputText = { type: 'output_text', text: '', annotations: [] };
  message.content.push(part);
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
      if (isOutputMessage(item) && event.part.type === 'output_text') {
        item.content.push(structuredClone(event.part));
      }
      return;
    }
    case 'response.output_text.delta': {
      const item = state.byItemId.get(event.item_id);
      if (isOutputMessage(item)) trailingOutputText(item).text += event.delta;
      return;
    }
    case 'response.output_text.done': {
      const item = state.byItemId.get(event.item_id);
      if (isOutputMessage(item)) trailingOutputText(item).text = event.text;
      return;
    }
    default: {
      // Everything else folds to nothing in this increment. The response
      // lifecycle (created/completed/failed) and the stream-level `error` carry
      // no item state the reducer needs: run termination — including failure —
      // is observed out-of-band via the transport run-end event, never folded
      // into items. content_part.done, reasoning, refusals, function calls, and
      // hosted tools are out of this increment's subset.
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
