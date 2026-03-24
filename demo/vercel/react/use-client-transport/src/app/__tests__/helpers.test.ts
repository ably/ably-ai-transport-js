import { describe, expect, it } from 'vitest';

import { userMessage } from '../helpers';

describe('userMessage', () => {
  it('creates a UIMessage with role "user"', () => {
    const msg = userMessage('hello');
    expect(msg.role).toBe('user');
  });

  it('creates a single text part with the given text', () => {
    const msg = userMessage('hello world');
    expect(msg.parts).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('generates a unique id for each message', () => {
    const msg1 = userMessage('a');
    const msg2 = userMessage('b');
    expect(msg1.id).toBeTruthy();
    expect(msg2.id).toBeTruthy();
    expect(msg1.id).not.toBe(msg2.id);
  });
});
