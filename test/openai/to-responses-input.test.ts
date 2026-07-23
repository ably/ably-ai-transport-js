import type { Responses } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import type { OpenAIMessage } from '../../src/openai/index.js';
import { toResponsesInput } from '../../src/openai/index.js';
import { userTurn } from './codec/fixtures.js';

describe('toResponsesInput', () => {
  it('concatenates each message’s items in order, by identity', () => {
    const user = userTurn('what is the weather?');
    const assistantMessage: Responses.ResponseOutputMessage = {
      id: 'm1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'sunny', annotations: [] }],
    };
    const call: Responses.ResponseFunctionToolCall = {
      type: 'function_call',
      call_id: 'c1',
      name: 'get_weather',
      arguments: '{}',
      status: 'completed',
    };
    // A server-side tool message carries the call and its output; both are valid
    // model input, so a follow-up /responses request sees a complete pair.
    const output: Responses.ResponseInputItem.FunctionCallOutput = {
      type: 'function_call_output',
      call_id: 'c1',
      output: 'sunny',
    };
    const assistant: OpenAIMessage = { role: 'assistant', items: [call, output, assistantMessage] };

    const input = toResponsesInput([user, assistant]);

    // No translation: the conversation's items pass through by reference, in order.
    expect(input).toHaveLength(4);
    expect(input[0]).toBe(user.items[0]);
    expect(input[1]).toBe(call);
    expect(input[2]).toBe(output);
    expect(input[3]).toBe(assistantMessage);
  });

  it('feeds only the message items to the model, keeping out-of-band toolCallStates out of the input', () => {
    // A denied gated call: the reducer records the decision in toolCallStates
    // (out-of-band, for the client to render) and writes a rejection
    // function_call_output into items (valid model input). Only the item may
    // reach /responses — toolCallStates is not a ResponseInputItem and must not.
    const rejection: Responses.ResponseInputItem.FunctionCallOutput = {
      type: 'function_call_output',
      call_id: 'c1',
      output: 'User denied',
    };
    const assistant: OpenAIMessage = {
      role: 'assistant',
      items: [rejection],
      toolCallStates: { c1: { approval: 'denied', reason: 'User denied' } },
    };

    const input = toResponsesInput([assistant]);

    expect(input).toEqual([rejection]);
    expect(input[0]).toBe(rejection);
  });

  it('returns an empty array for an empty conversation', () => {
    expect(toResponsesInput([])).toEqual([]);
  });
});
