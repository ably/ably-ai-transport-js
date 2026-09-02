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
 * Find the function calls that still owe the model an answer: a `function_call`
 * with no `function_call_output` that is not approved either.
 *
 * An approved call counts as answered even though its output has not folded yet —
 * the agent runs it server-side on resume (see {@link approvedUnexecutedCalls})
 * before the next model turn, so its output exists by the time the model sees the
 * conversation. A denial also counts, because a denial is answered on the wire by
 * a `function_call_output` item recording the rejection, which the resolved check
 * already covers. A call still `pending` a decision, and a client-executed call
 * whose result has not arrived, are both unanswered.
 *
 * A caller resuming a run reads this to decide whether the run is ready to
 * continue at all. Every open `function_call` must carry a matching output in the
 * model input, so resuming while any call is unanswered makes the provider reject
 * the request. Pass the messages of the run being resumed.
 * @param messages - The conversation messages to scan.
 * @returns The calls still awaiting an answer, in message/item order.
 */
export const unansweredCalls = (messages: OpenAIMessage[]): Responses.ResponseFunctionToolCall[] => {
  const resolved = resolvedCallIds(messages);
  const calls: Responses.ResponseFunctionToolCall[] = [];
  for (const message of messages) {
    const states = message.toolCallStates ?? {};
    for (const item of message.items) {
      if (item.type !== 'function_call' || resolved.has(item.call_id)) continue;
      if (states[item.call_id]?.approval !== 'approved') calls.push(item);
    }
  }
  return calls;
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
