import type { OpenAIMessage } from '@ably/ai-transport/openai';
import { approvedUnexecutedCalls, resolvedCallIds, unansweredCalls } from '@ably/ai-transport/openai';
import type { Responses } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

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
