import { describe, expect, it } from 'vitest';
import type { OpenAIMessage } from '../lib/openai-thread';

import { collectToolCallStates, collectToolOutputs, toDisplayParts } from '../display';

describe('toDisplayParts', () => {
  it('pairs a function_call with its function_call_output and renders trailing text', () => {
    const message: OpenAIMessage = {
      role: 'assistant',
      items: [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'getWeather',
          arguments: '{"location":"London"}',
          status: 'completed',
        },
        { type: 'function_call_output', call_id: 'c1', output: '{"temperature":12}' },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'It is 12°C.', annotations: [] }],
        },
      ],
    };

    expect(toDisplayParts(message)).toEqual([
      { kind: 'tool', callId: 'c1', name: 'getWeather', args: '{"location":"London"}', output: '{"temperature":12}' },
      { kind: 'text', text: 'It is 12°C.' },
    ]);
  });

  it('leaves a tool part pending (output undefined) when no result has arrived', () => {
    const message: OpenAIMessage = {
      role: 'assistant',
      items: [{ type: 'function_call', call_id: 'c1', name: 'getWeather', arguments: '{}', status: 'in_progress' }],
    };
    expect(toDisplayParts(message)).toEqual([
      { kind: 'tool', callId: 'c1', name: 'getWeather', args: '{}', output: undefined },
    ]);
  });

  it('yields no parts for a message holding only a function_call_output', () => {
    const message: OpenAIMessage = {
      role: 'assistant',
      items: [{ type: 'function_call_output', call_id: 'c1', output: '{"temperature":12}' }],
    };
    expect(toDisplayParts(message)).toEqual([]);
  });

  it('pairs a call with an output supplied from a sibling message via toolOutputs', () => {
    const callMessage: OpenAIMessage = {
      role: 'assistant',
      items: [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'getWeather',
          arguments: '{"location":"Tokyo"}',
          status: 'completed',
        },
      ],
    };
    const outputMessage: OpenAIMessage = {
      role: 'assistant',
      items: [{ type: 'function_call_output', call_id: 'c1', output: '{"temperature":20}' }],
    };

    const toolOutputs = collectToolOutputs([callMessage, outputMessage]);
    expect(toDisplayParts(callMessage, toolOutputs)).toEqual([
      { kind: 'tool', callId: 'c1', name: 'getWeather', args: '{"location":"Tokyo"}', output: '{"temperature":20}' },
    ]);
  });

  it("folds a call's approval and result state from toolStates onto the tool part", () => {
    const callMessage: OpenAIMessage = {
      role: 'assistant',
      items: [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'getWeatherForecast',
          arguments: '{"location":"Paris"}',
          status: 'completed',
        },
      ],
      toolCallStates: { c1: { approval: 'approved', result: 'ok' } },
    };

    const toolStates = collectToolCallStates([callMessage]);
    expect(toDisplayParts(callMessage, undefined, toolStates)).toEqual([
      {
        kind: 'tool',
        callId: 'c1',
        name: 'getWeatherForecast',
        args: '{"location":"Paris"}',
        output: undefined,
        approval: 'approved',
        result: 'ok',
      },
    ]);
  });

  it('renders a reasoning item (its summary parts joined) before the reply', () => {
    const message: OpenAIMessage = {
      role: 'assistant',
      items: [
        {
          id: 'rs_1',
          type: 'reasoning',
          summary: [
            { type: 'summary_text', text: 'First thought.' },
            { type: 'summary_text', text: 'Second thought.' },
          ],
        },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'The answer.', annotations: [] }],
        },
      ],
    };

    expect(toDisplayParts(message)).toEqual([
      { kind: 'reasoning', text: 'First thought.\n\nSecond thought.' },
      { kind: 'text', text: 'The answer.' },
    ]);
  });

  it('skips an empty reasoning item (no summary parts)', () => {
    const message: OpenAIMessage = {
      role: 'assistant',
      items: [{ id: 'rs_1', type: 'reasoning', summary: [] }],
    };
    expect(toDisplayParts(message)).toEqual([]);
  });

  it('renders a user turn with a single input_text as one text part', () => {
    const message: OpenAIMessage = {
      role: 'user',
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi there' }] }],
    };
    expect(toDisplayParts(message)).toEqual([{ kind: 'text', text: 'hi there' }]);
  });

  it('renders a refusal content part as text', () => {
    const message: OpenAIMessage = {
      role: 'assistant',
      items: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
        },
      ],
    };
    expect(toDisplayParts(message)).toEqual([{ kind: 'text', text: 'I cannot help with that.' }]);
  });
});

describe('collectToolOutputs', () => {
  it('collects function_call_output items across messages keyed by call_id', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [{ type: 'function_call_output', call_id: 'c1', output: '{"temperature":20}' }] },
      { role: 'assistant', items: [{ type: 'function_call_output', call_id: 'c2', output: '{"temperature":5}' }] },
    ];
    const outputs = collectToolOutputs(messages);
    expect(outputs.get('c1')).toBe('{"temperature":20}');
    expect(outputs.get('c2')).toBe('{"temperature":5}');
  });

  it('stringifies a structured (non-string) output', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'assistant',
        items: [{ type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'sunny' }] }],
      },
    ];
    expect(collectToolOutputs(messages).get('c1')).toBe('[{"type":"input_text","text":"sunny"}]');
  });
});

describe('collectToolCallStates', () => {
  it('merges a call_id state across messages, later fields winning', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', items: [], toolCallStates: { c1: { approval: 'approved' } } },
      { role: 'assistant', items: [], toolCallStates: { c1: { result: 'ok' } } },
    ];
    const states = collectToolCallStates(messages);
    expect(states.get('c1')).toEqual({ approval: 'approved', result: 'ok' });
  });

  it('returns an empty map when no message carries toolCallStates', () => {
    const messages: OpenAIMessage[] = [{ role: 'assistant', items: [] }];
    expect(collectToolCallStates(messages).size).toBe(0);
  });
});
