/**
 * Project an `OpenAIMessage[]` into display parts.
 *
 * A run splits its work across messages: each `pipe`/`send` mints a fresh
 * codec-message-id, so a `function_call` and its `function_call_output` land in
 * separate messages, and a call's out-of-band `toolCallState` folds onto the
 * message holding the call. These helpers pair a call with its output and state
 * by `call_id`, order-independent, so a tool interaction becomes one display
 * part even though its pieces arrive across sibling messages.
 *
 * The two-level flow a caller wires: {@link collectToolOutputs} /
 * {@link collectToolCallStates} gather the whole conversation's outputs and
 * states into `call_id`-keyed maps, then {@link toDisplayParts} projects one
 * message at a time, reading those maps to pair across messages. The split
 * exists because a visible window is scoped per message while pairing spans the
 * whole conversation.
 */

import type { OpenAIItem, OpenAIMessage, OpenAIToolCallState } from '@ably/ai-transport/openai';

/**
 * A display part of a message: a run of message text, a reasoning summary, or a
 * tool interaction (the call, its approval decision if gated, and its output
 * once it arrives).
 */
export type DisplayPart =
  | {
      /** A run of assistant/user message text. */
      kind: 'text';
      /** The text content. */
      text: string;
    }
  | {
      /** A reasoning model's streamed summary — its "thinking". */
      kind: 'reasoning';
      /** The summary text (the reasoning item's summary parts joined). */
      text: string;
    }
  | {
      /** A tool call — server-executed, client-executed, or approval-gated. */
      kind: 'tool';
      /** The tool call's id, correlating the call with its output and state. */
      callId: string;
      /** The tool name (e.g. `getWeather`). */
      name: string;
      /** The call arguments as a JSON string (complete once the call is done). */
      args: string;
      /** The tool's output as a JSON string, or `undefined` while still running. */
      output?: string;
      /** The gated call's approval decision, present only for an approval-gated tool. */
      approval?: OpenAIToolCallState['approval'];
      /** The client-side execution result status, present once a client result or error folds. */
      result?: OpenAIToolCallState['result'];
    };

// Flatten a message item's content parts into text (empty for non-message items).
const messageItemText = (item: OpenAIItem): string => {
  if (item.type !== 'message') return '';
  const content = item.content;
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (part.type === 'output_text' || part.type === 'input_text') text += part.text;
    else if (part.type === 'refusal') text += part.refusal;
  }
  return text;
};

/**
 * Collect every `function_call_output` across the given messages into a
 * `call_id` → output-JSON map. A run splits its work across messages, so a call
 * and its output land in separate messages; this map lets a call pair with an
 * output that lives in a sibling message (see {@link toDisplayParts}).
 * @param messages - The conversation messages to scan.
 * @returns A map from `call_id` to the output serialized as JSON text.
 */
export const collectToolOutputs = (messages: OpenAIMessage[]): Map<string, string> => {
  const outputByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const item of message.items) {
      if (item.type === 'function_call_output') {
        outputByCallId.set(item.call_id, typeof item.output === 'string' ? item.output : JSON.stringify(item.output));
      }
    }
  }
  return outputByCallId;
};

/**
 * Collect every message's `toolCallStates` across the given messages into a
 * `call_id` → state map. A call's state (its approval decision and its
 * client-result status) folds onto the message holding the `function_call`, but
 * a run can page a message in before its call, so (as with
 * {@link collectToolOutputs}) this collector gathers the state across messages
 * and pairs it with the call by `call_id` (see {@link toDisplayParts}).
 * @param messages - The conversation messages to scan.
 * @returns A map from `call_id` to its merged {@link OpenAIToolCallState}.
 */
export const collectToolCallStates = (messages: OpenAIMessage[]): Map<string, OpenAIToolCallState> => {
  const stateByCallId = new Map<string, OpenAIToolCallState>();
  for (const message of messages) {
    for (const [callId, state] of Object.entries(message.toolCallStates ?? {})) {
      stateByCallId.set(callId, { ...stateByCallId.get(callId), ...state });
    }
  }
  return stateByCallId;
};

/**
 * Project one message's items into display parts in item order, pairing each
 * `function_call` with its matching `function_call_output` (by `call_id`,
 * order-independent) and its tool-call state so a tool interaction becomes one
 * part. The projection drops the output item from the flat stream and shows it
 * attached to its call. Pass `toolOutputs` / `toolStates` (from
 * {@link collectToolOutputs} / {@link collectToolCallStates}) to pair a call
 * with an output or state published in a sibling message; when omitted, only
 * this message's own are used. A message holding only `function_call_output`
 * items therefore yields no parts, because its outputs surface on the calls'
 * messages instead.
 * @param message - The message to project.
 * @param toolOutputs - Optional whole-conversation output map for cross-message pairing.
 * @param toolStates - Optional whole-conversation state map for cross-message pairing.
 * @returns The message's display parts, in item order.
 */
export const toDisplayParts = (
  message: OpenAIMessage,
  toolOutputs?: Map<string, string>,
  toolStates?: Map<string, OpenAIToolCallState>,
): DisplayPart[] => {
  const outputByCallId = toolOutputs ?? collectToolOutputs([message]);
  const stateByCallId = toolStates ?? collectToolCallStates([message]);

  const parts: DisplayPart[] = [];
  for (const item of message.items) {
    switch (item.type) {
      case 'function_call': {
        const state = stateByCallId.get(item.call_id);
        parts.push({
          kind: 'tool',
          callId: item.call_id,
          name: item.name,
          args: item.arguments,
          output: outputByCallId.get(item.call_id),
          approval: state?.approval,
          result: state?.result,
        });

        break;
      }
      case 'reasoning': {
        // The streamed summary (its parts joined), the model's "thinking".
        const text = item.summary.map((s) => s.text).join('\n\n');
        if (text) parts.push({ kind: 'reasoning', text });

        break;
      }
      case 'message': {
        const text = messageItemText(item);
        if (text) parts.push({ kind: 'text', text });

        break;
      }
      // No default
    }
    // function_call_output is shown with its call; other item types are not
    // yet rendered.
  }
  return parts;
};
