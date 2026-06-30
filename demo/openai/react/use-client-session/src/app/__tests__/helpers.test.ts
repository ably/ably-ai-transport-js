import { describe, expect, it } from 'vitest';
import type { OpenAITurn } from '@ably/ai-transport/openai';

import { turnText, userTurn } from '../helpers';

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
