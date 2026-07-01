import type { Responses } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import type { OpenAITurn } from '../../src/openai/index.js';
import { toResponsesInput } from '../../src/openai/index.js';
import { userTurn } from './codec/fixtures.js';

describe('toResponsesInput', () => {
  it('concatenates each turn’s items in order, by identity', () => {
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
    // A server-side tool turn carries the call and its output; both are valid
    // model input, so a follow-up /responses request sees a complete pair.
    const output: Responses.ResponseInputItem.FunctionCallOutput = {
      type: 'function_call_output',
      call_id: 'c1',
      output: 'sunny',
    };
    const assistant: OpenAITurn = { role: 'assistant', items: [call, output, assistantMessage] };

    const input = toResponsesInput([user, assistant]);

    // No translation: the conversation's items pass through by reference, in order.
    expect(input).toHaveLength(4);
    expect(input[0]).toBe(user.items[0]);
    expect(input[1]).toBe(call);
    expect(input[2]).toBe(output);
    expect(input[3]).toBe(assistantMessage);
  });

  it('returns an empty array for an empty conversation', () => {
    expect(toResponsesInput([])).toEqual([]);
  });
});
