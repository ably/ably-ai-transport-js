/**
 * Correlation readers over an `OpenAIMessage[]`: the loop's view of which tool
 * calls are resolved and which approved-but-unexecuted gated calls still need to
 * run server-side.
 *
 * A run splits its work across messages, so a `function_call` and its
 * `function_call_output` land in separate messages, and a gated call's approval
 * decision folds onto the message holding the call as out-of-band
 * `toolCallState`. These readers pair those pieces by `call_id`,
 * order-independent, so the loop can decide what to do next from the hydrated
 * conversation alone.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { OpenAIMessage } from './codec/index.js';

/**
 * The `call_id`s of every `function_call_output` present across the given
 * messages. A resolved call is one whose output has folded in, so the loop skips
 * it and a renderer shows its output attached to the call.
 * @param messages - The conversation messages to scan.
 * @returns The set of resolved `call_id`s.
 */
export const resolvedCallIds = (messages: OpenAIMessage[]): Set<string> => {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const item of message.items) {
      if (item.type === 'function_call_output') ids.add(item.call_id);
    }
  }
  return ids;
};

/**
 * Find the gated function calls the user has approved but the agent has not yet
 * run: a `function_call` whose `toolCallStates[call_id].approval === 'approved'`
 * with no `function_call_output` present. On resume the agent must run these
 * server-side before the next model turn.
 * @param messages - The conversation messages to scan.
 * @returns The approved-but-unexecuted gated calls, in message/item order.
 */
export const approvedUnexecutedCalls = (messages: OpenAIMessage[]): Responses.ResponseFunctionToolCall[] => {
  const resolved = resolvedCallIds(messages);
  const calls: Responses.ResponseFunctionToolCall[] = [];
  for (const message of messages) {
    const states = message.toolCallStates ?? {};
    for (const item of message.items) {
      if (item.type !== 'function_call' || resolved.has(item.call_id)) continue;
      if (states[item.call_id]?.approval === 'approved') calls.push(item);
    }
  }
  return calls;
};
