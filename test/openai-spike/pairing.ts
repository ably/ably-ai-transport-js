/**
 * AIT-742 Phase 0 spike — render-time pairing of tool call + result by `call_id`.
 *
 * Tool call (`function_call`) and result (`function_call_output`) are two
 * separate items linked by `call_id` (§5). We do NOT invent a merged "tool"
 * TMessage type; instead a render-time helper pairs them for display. This is
 * the consumer-facing ergonomics check for hypothesis 4.
 */

import type { OpenAIItem, OpenAITurn } from './events.js';
import type { ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses';

/** A renderable "tool interaction": the call, plus its result if one has arrived. */
export interface ToolPair {
  callId: string;
  name: string;
  arguments: string;
  /** The output text, or `undefined` while the call is still awaiting a result. */
  output?: string;
}

/** A flattened render item: a plain item, or a paired tool call+result. */
export type RenderItem = { kind: 'item'; item: OpenAIItem } | { kind: 'tool'; pair: ToolPair };

const isFunctionCall = (item: OpenAIItem): item is ResponseFunctionToolCall => item.type === 'function_call';
const isFunctionCallOutput = (item: OpenAIItem): item is ResponseInputItem.FunctionCallOutput =>
  item.type === 'function_call_output';

const outputToString = (output: ResponseInputItem.FunctionCallOutput['output']): string =>
  typeof output === 'string' ? output : JSON.stringify(output);

/**
 * Project a turn's items into render items, folding each `function_call` and
 * its matching `function_call_output` (by `call_id`) into a single `ToolPair`.
 * Items keep their original order; the result item is dropped from the stream
 * (it is shown attached to its call).
 */
export const toRenderItems = (turn: OpenAITurn): RenderItem[] => {
  const resultByCallId = new Map<string, string>();
  for (const item of turn.items) {
    if (isFunctionCallOutput(item)) resultByCallId.set(item.call_id, outputToString(item.output));
  }

  const render: RenderItem[] = [];
  for (const item of turn.items) {
    if (isFunctionCall(item)) {
      render.push({
        kind: 'tool',
        pair: {
          callId: item.call_id,
          name: item.name,
          arguments: item.arguments,
          output: resultByCallId.get(item.call_id),
        },
      });
    } else if (isFunctionCallOutput(item)) {
      // Shown attached to its call; skip in the flat stream.
    } else {
      render.push({ kind: 'item', item });
    }
  }
  return render;
};
