/**
 * AIT-742 Phase 0 spike — the Responses reducer (init / fold / getMessages).
 *
 * This is a deliberate **mirror** of the SDK's `accumulateResponse`
 * (`openai/lib/responses/ResponseAccumulator`), re-keyed on `item_id` instead
 * of `output_index`.
 *
 * Why re-keyed (a spike finding): `accumulateResponse` locates the item to
 * mutate by `event.output_index` — a positional index into `Response.output`.
 * That index is only carried on the *lifecycle/structural* events; the codec's
 * wire stream model strips a streamed delta down to `(stream-id, text)` (see
 * `output-descriptor-decoder.ts` `buildDelta`, which emits only `idField` +
 * `deltaField`). So after a wire round-trip a `response.output_text.delta`
 * no longer carries `output_index`, and `accumulateResponse` would throw
 * `missing output at index undefined`. The stream id we *do* have is `item_id`.
 * Re-keying on `item_id` is a pure codec-side concern (no core change) but it
 * does mean the SDK function cannot be called verbatim on the decoded stream —
 * only mirrored. The reduction logic is otherwise identical.
 *
 * Subset handled (per the brief): lifecycle (created / in_progress / completed /
 * failed / incomplete + stream `error`), `output_text` delta/done,
 * `function_call_arguments` delta/done, `output_item` added/done,
 * `content_part` added/done, plus `refusal` delta/done (folds as content, not
 * an error). Inputs: `user-message`, `tool-result`.
 */

import type { CodecEvent, CodecMessage, ReducerMeta } from '../../src/core/codec/index.js';
import type { OpenAIInput, OpenAIItem, OpenAIOutput, OpenAITurn } from './events.js';
import type {
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseOutputRefusal,
  ResponseOutputText,
} from 'openai/resources/responses/responses';

/** Per-node projection: one turn's items, accumulated, keyed by item id. */
export interface OpenAIProjection {
  role: 'user' | 'assistant';
  /** Ordered items (the turn). */
  items: OpenAIItem[];
  /** item_id -> the live (mutable) item in `items`, for delta accumulation. */
  byItemId: Map<string, OpenAIItem>;
  codecMessageId: string;
  /** Coarse run-outcome signal read by openaiRunOutcome — never used to mutate items. */
  responseStatus?: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';
  /** Captured for openaiRunOutcome; the reducer does not fold errors into items. */
  errorMessage?: string;
}

export const init = (): OpenAIProjection => ({
  role: 'assistant',
  items: [],
  byItemId: new Map(),
  codecMessageId: '',
});

const isMessage = (item: OpenAIItem | undefined): item is ResponseOutputMessage => item?.type === 'message';
const isFunctionCall = (item: OpenAIItem | undefined): item is ResponseFunctionToolCall =>
  item?.type === 'function_call';

/** Lazily ensure the message item has a trailing output_text part to append into. */
const lastOutputText = (msg: ResponseOutputMessage): ResponseOutputText => {
  const tail = msg.content.at(-1);
  if (tail && tail.type === 'output_text') return tail;
  const part: ResponseOutputText = { type: 'output_text', text: '', annotations: [] };
  msg.content.push(part);
  return part;
};

const lastRefusal = (msg: ResponseOutputMessage): ResponseOutputRefusal => {
  const tail = msg.content.at(-1);
  if (tail && tail.type === 'refusal') return tail;
  const part: ResponseOutputRefusal = { type: 'refusal', refusal: '' };
  msg.content.push(part);
  return part;
};

const foldOutput = (state: OpenAIProjection, event: OpenAIOutput): void => {
  switch (event.type) {
    case 'response.created':
    case 'response.in_progress':
    case 'response.queued': {
      state.role = 'assistant';
      state.responseStatus = event.response.status;
      break;
    }
    case 'response.output_item.added': {
      const clone = structuredClone(event.item) as OpenAIItem;
      state.items.push(clone);
      const id = (clone as { id?: string }).id;
      if (id) state.byItemId.set(id, clone);
      break;
    }
    case 'response.output_item.done': {
      const clone = structuredClone(event.item) as OpenAIItem;
      const id = (clone as { id?: string }).id;
      const idx = id ? state.items.findIndex((i) => (i as { id?: string }).id === id) : -1;
      if (idx >= 0) state.items[idx] = clone;
      else state.items.push(clone);
      if (id) state.byItemId.set(id, clone);
      break;
    }
    case 'response.content_part.added': {
      const item = state.byItemId.get(event.item_id);
      if (isMessage(item) && event.part.type !== 'reasoning_text') {
        item.content.push(structuredClone(event.part));
      }
      break;
    }
    case 'response.content_part.done': {
      // The final part value arrives on done; for the spike the delta path has
      // already built it, so this is a no-op beyond confirming closure.
      break;
    }
    case 'response.output_text.delta': {
      const item = state.byItemId.get(event.item_id);
      if (isMessage(item)) lastOutputText(item).text += event.delta;
      break;
    }
    case 'response.output_text.done': {
      const item = state.byItemId.get(event.item_id);
      if (isMessage(item)) lastOutputText(item).text = event.text;
      break;
    }
    case 'response.refusal.delta': {
      const item = state.byItemId.get(event.item_id);
      if (isMessage(item)) lastRefusal(item).refusal += event.delta;
      break;
    }
    case 'response.refusal.done': {
      const item = state.byItemId.get(event.item_id);
      if (isMessage(item)) lastRefusal(item).refusal = event.refusal;
      break;
    }
    case 'response.function_call_arguments.delta': {
      const item = state.byItemId.get(event.item_id);
      if (isFunctionCall(item)) item.arguments += event.delta;
      break;
    }
    case 'response.function_call_arguments.done': {
      const item = state.byItemId.get(event.item_id);
      if (isFunctionCall(item)) item.arguments = event.arguments;
      break;
    }
    case 'response.completed':
    case 'response.incomplete': {
      state.responseStatus = event.response.status;
      break;
    }
    case 'response.failed': {
      // The reducer does NOT mutate items on failure — run termination is
      // observed via the transport run-end event / openaiRunOutcome (hyp 8).
      state.responseStatus = event.response.status;
      state.errorMessage = event.response.error?.message;
      break;
    }
    case 'error': {
      // Stream-level error — likewise not folded into items.
      state.errorMessage = event.message;
      break;
    }
    default: {
      // Out of the spike subset (reasoning, hosted tools, audio, annotations…).
      break;
    }
  }
};

export const fold = (
  state: OpenAIProjection,
  event: CodecEvent<OpenAIInput, OpenAIOutput>,
  meta: ReducerMeta,
): OpenAIProjection => {
  if (meta.messageId) state.codecMessageId = meta.messageId;

  if (event.direction === 'output') {
    foldOutput(state, event.event);
    return state;
  }

  const input = event.event;
  switch (input.kind) {
    case 'user-message': {
      state.role = 'user';
      // A user turn's items are supplied verbatim by the caller.
      for (const item of input.message.items) state.items.push(item);
      break;
    }
    case 'tool-result': {
      // The tool result is an *input* item appended to the suspended assistant
      // turn (same codec-message-id => same node => same message) (hyp 6).
      state.items.push({
        type: 'function_call_output',
        call_id: input.payload.callId,
        output: input.payload.output,
        id: `fco_${input.payload.callId}`,
        status: 'completed',
      });
      break;
    }
  }
  return state;
};

export const getMessages = (projection: OpenAIProjection): CodecMessage<OpenAITurn>[] => {
  if (projection.items.length === 0) return [];
  return [{ codecMessageId: projection.codecMessageId, message: { role: projection.role, items: projection.items } }];
};
