import { describe, expect, it } from 'vitest';
import type { OpenAIMessage } from '@ably/ai-transport/openai';

import { collectToolOutputs, toRenderItems, turnText, userTurn } from '../helpers';

describe('userTurn', () => {
  it('creates a user turn with a single input_text message item', () => {
    const turn = userTurn('hello world');
    expect(turn.role).toBe('user');
    expect(turn.items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello world' }] },
    ]);
  });
});

describe('turnText', () => {
  it('reads the input_text of a user turn', () => {
    expect(turnText(userTurn('hi there'))).toBe('hi there');
  });

  it('concatenates the output_text parts of an assistant turn', () => {
    const turn: OpenAIMessage = {
      role: 'assistant',
      items: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'Hello, ', annotations: [] },
            { type: 'output_text', text: 'world', annotations: [] },
          ],
        },
      ],
    };
    expect(turnText(turn)).toBe('Hello, world');
  });

  it('renders a refusal as text', () => {
    const turn: OpenAIMessage = {
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
    expect(turnText(turn)).toBe('I cannot help with that.');
  });
});

describe('toRenderItems', () => {
  it('pairs a function_call with its function_call_output and renders trailing text', () => {
    const turn: OpenAIMessage = {
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

    const parts = toRenderItems(turn);
    expect(parts).toEqual([
      { kind: 'tool', callId: 'c1', name: 'getWeather', args: '{"location":"London"}', output: '{"temperature":12}' },
      { kind: 'text', text: 'It is 12°C.' },
    ]);
  });

  it('leaves a tool part pending (output undefined) when no result has arrived', () => {
    const turn: OpenAIMessage = {
      role: 'assistant',
      items: [{ type: 'function_call', call_id: 'c1', name: 'getWeather', arguments: '{}', status: 'in_progress' }],
    };
    expect(toRenderItems(turn)).toEqual([
      { kind: 'tool', callId: 'c1', name: 'getWeather', args: '{}', output: undefined },
    ]);
  });

  it('renders a plain text turn as a single text part', () => {
    expect(toRenderItems(userTurn('hi there'))).toEqual([{ kind: 'text', text: 'hi there' }]);
  });

  it('yields no parts for a turn holding only a function_call_output', () => {
    const turn: OpenAIMessage = {
      role: 'assistant',
      items: [{ type: 'function_call_output', call_id: 'c1', output: '{"temperature":12}' }],
    };
    expect(toRenderItems(turn)).toEqual([]);
  });

  it('pairs a call with an output supplied from a sibling message via toolOutputs', () => {
    const callTurn: OpenAIMessage = {
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
    const outputTurn: OpenAIMessage = {
      role: 'assistant',
      items: [{ type: 'function_call_output', call_id: 'c1', output: '{"temperature":20}' }],
    };

    const toolOutputs = collectToolOutputs([callTurn, outputTurn]);
    expect(toRenderItems(callTurn, toolOutputs)).toEqual([
      { kind: 'tool', callId: 'c1', name: 'getWeather', args: '{"location":"Tokyo"}', output: '{"temperature":20}' },
    ]);
  });

  it('renders a reasoning item as a reasoning part (its summary parts joined) before the reply', () => {
    const turn: OpenAIMessage = {
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

    expect(toRenderItems(turn)).toEqual([
      { kind: 'reasoning', text: 'First thought.\n\nSecond thought.' },
      { kind: 'text', text: 'The answer.' },
    ]);
  });
});

describe('collectToolOutputs', () => {
  it('collects function_call_output items across messages keyed by call_id', () => {
    const turns: OpenAIMessage[] = [
      {
        role: 'assistant',
        items: [{ type: 'function_call_output', call_id: 'c1', output: '{"temperature":20}' }],
      },
      {
        role: 'assistant',
        items: [{ type: 'function_call_output', call_id: 'c2', output: '{"temperature":5}' }],
      },
    ];
    const outputs = collectToolOutputs(turns);
    expect(outputs.get('c1')).toBe('{"temperature":20}');
    expect(outputs.get('c2')).toBe('{"temperature":5}');
  });

  it('stringifies a structured (non-string) output', () => {
    const turns: OpenAIMessage[] = [
      {
        role: 'assistant',
        items: [
          {
            type: 'function_call_output',
            call_id: 'c1',
            output: [{ type: 'input_text', text: 'sunny' }],
          },
        ],
      },
    ];
    expect(collectToolOutputs(turns).get('c1')).toBe('[{"type":"input_text","text":"sunny"}]');
  });
});
