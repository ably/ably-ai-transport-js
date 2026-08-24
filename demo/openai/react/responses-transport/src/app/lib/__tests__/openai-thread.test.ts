/**
 * Tests for the demo's OpenAI conversation model: the agent loop's
 * correlation readers, the model-input flatten, and the passthrough-input
 * narrowing boundary.
 */

import type { Responses } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import {
  approvedUnexecutedCalls,
  asOpenAIInput,
  type OpenAIMessage,
  resolvedCallIds,
  toResponsesInput,
  unansweredCalls,
} from '../openai-thread';

/** A plain-text user message: one input message item with a single input_text part. */
const userTurn = (text: string): OpenAIMessage => ({
  role: 'user',
  items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
});

const gatedCall = (call_id: string, name = 'getWeatherForecast'): Responses.ResponseFunctionToolCall => ({
  id: `fc-${call_id}`,
  type: 'function_call',
  call_id,
  name,
  arguments: '{"location":"Paris"}',
  status: 'completed',
});

describe('resolvedCallIds', () => {
  it('collects the call_id of every function_call_output across messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [gatedCall('c1')] },
      { role: 'assistant', items: [{ type: 'function_call_output', call_id: 'c1', output: '{}' }] },
      { role: 'assistant', items: [{ type: 'function_call_output', call_id: 'c2', output: '{}' }] },
    ];
    const resolved = resolvedCallIds(messages);
    expect([...resolved].toSorted()).toEqual(['c1', 'c2']);
  });

  it('returns an empty set when no output has folded', () => {
    const messages: OpenAIMessage[] = [{ role: 'assistant', items: [gatedCall('c1')] }];
    expect(resolvedCallIds(messages).size).toBe(0);
  });
});

describe('approvedUnexecutedCalls', () => {
  it('returns an approved gated call with no output yet', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [gatedCall('c1')], toolCallStates: { c1: { approval: 'approved' } } },
    ];
    expect(approvedUnexecutedCalls(messages)).toEqual([gatedCall('c1')]);
  });

  it('skips an approved call that already has an output', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [gatedCall('c1')], toolCallStates: { c1: { approval: 'approved' } } },
      { role: 'assistant', items: [{ type: 'function_call_output', call_id: 'c1', output: '{}' }] },
    ];
    expect(approvedUnexecutedCalls(messages)).toEqual([]);
  });

  it('skips a pending or denied gated call', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [gatedCall('c1')], toolCallStates: { c1: { approval: 'pending' } } },
      { role: 'assistant', items: [gatedCall('c2')], toolCallStates: { c2: { approval: 'denied' } } },
    ];
    expect(approvedUnexecutedCalls(messages)).toEqual([]);
  });

  it('skips a call with no tool-call state', () => {
    const messages: OpenAIMessage[] = [{ role: 'assistant', items: [gatedCall('c1')] }];
    expect(approvedUnexecutedCalls(messages)).toEqual([]);
  });

  it('returns approved-unexecuted calls in message/item order', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'assistant',
        items: [gatedCall('c1'), gatedCall('c2')],
        toolCallStates: { c1: { approval: 'approved' }, c2: { approval: 'approved' } },
      },
    ];
    expect(approvedUnexecutedCalls(messages).map((c) => c.call_id)).toEqual(['c1', 'c2']);
  });
});

describe('unansweredCalls', () => {
  it('returns a call awaiting an approval decision', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [gatedCall('c1')], toolCallStates: { c1: { approval: 'pending' } } },
    ];
    expect(unansweredCalls(messages).map((c) => c.call_id)).toEqual(['c1']);
  });

  it('returns a client-tool call whose result has not arrived', () => {
    const messages: OpenAIMessage[] = [{ role: 'assistant', items: [gatedCall('c1', 'getLocation')] }];
    expect(unansweredCalls(messages).map((c) => c.call_id)).toEqual(['c1']);
  });

  it('treats an approved call as answered even with no output yet', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [gatedCall('c1')], toolCallStates: { c1: { approval: 'approved' } } },
    ];
    expect(unansweredCalls(messages)).toEqual([]);
  });

  it('treats a denied call as answered, via its rejection output', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [gatedCall('c1')], toolCallStates: { c1: { approval: 'denied' } } },
      { role: 'assistant', items: [{ type: 'function_call_output', call_id: 'c1', output: 'not approved' }] },
    ];
    expect(unansweredCalls(messages)).toEqual([]);
  });

  it('treats a call with a folded output as answered', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [gatedCall('c1', 'getWeather')] },
      { role: 'assistant', items: [{ type: 'function_call_output', call_id: 'c1', output: '{}' }] },
    ];
    expect(unansweredCalls(messages)).toEqual([]);
  });

  it('returns only the still-pending call when one of two gated calls is approved', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'assistant',
        items: [gatedCall('c1'), gatedCall('c2')],
        toolCallStates: { c1: { approval: 'approved' }, c2: { approval: 'pending' } },
      },
    ];
    expect(unansweredCalls(messages).map((c) => c.call_id)).toEqual(['c2']);
  });

  it('returns both gated calls of a turn while neither has been decided', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'assistant',
        items: [gatedCall('c1'), gatedCall('c2')],
        toolCallStates: { c1: { approval: 'pending' }, c2: { approval: 'pending' } },
      },
    ];
    expect(unansweredCalls(messages).map((c) => c.call_id)).toEqual(['c1', 'c2']);
  });
});

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

describe('asOpenAIInput', () => {
  it('narrows each of the demo input kinds', () => {
    expect(asOpenAIInput({ kind: 'regenerate' })).toEqual({ kind: 'regenerate' });
    expect(asOpenAIInput({ kind: 'message', payload: userTurn('hi') })).toEqual({
      kind: 'message',
      payload: userTurn('hi'),
    });
    expect(
      asOpenAIInput({ kind: 'item', payload: { type: 'function_call_output', call_id: 'c1', output: '{}' } }),
    ).toEqual({ kind: 'item', payload: { type: 'function_call_output', call_id: 'c1', output: '{}' } });
    expect(asOpenAIInput({ kind: 'approval', payload: { call_id: 'c1', approved: true } })).toEqual({
      kind: 'approval',
      payload: { call_id: 'c1', approved: true },
    });
  });

  it('narrows an unrecognised body to undefined', () => {
    expect(asOpenAIInput('a plain string')).toBeUndefined();
    expect(asOpenAIInput({ kind: 'someone-elses-kind', payload: {} })).toBeUndefined();
    expect(asOpenAIInput({ kind: 'item', payload: { type: 'not-an-item' } })).toBeUndefined();
  });
});
