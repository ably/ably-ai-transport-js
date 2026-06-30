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
    const assistant: OpenAITurn = { role: 'assistant', items: [assistantMessage, call] };

    const input = toResponsesInput([user, assistant]);

    // No translation: the conversation's items pass through by reference, in order.
    expect(input).toHaveLength(3);
    expect(input[0]).toBe(user.items[0]);
    expect(input[1]).toBe(assistantMessage);
    expect(input[2]).toBe(call);
  });

  it('returns an empty array for an empty conversation', () => {
    expect(toResponsesInput([])).toEqual([]);
  });
});
