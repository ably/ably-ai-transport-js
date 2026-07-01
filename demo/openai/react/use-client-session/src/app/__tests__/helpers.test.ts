import { describe, expect, it } from 'vitest';
import type { OpenAITurn } from '@ably/ai-transport/openai';

import { toRenderItems, turnText, userTurn } from '../helpers';

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
    const turn: OpenAITurn = {
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
    const turn: OpenAITurn = {
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
    const turn: OpenAITurn = {
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
    const turn: OpenAITurn = {
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
});
