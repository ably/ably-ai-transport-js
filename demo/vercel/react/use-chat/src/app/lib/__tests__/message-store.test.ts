/**
 * Tests for the demo's server-owned conversation store: it holds the merged
 * messages and the channel serial they are complete up to, replaces the
 * messages wholesale on the next write, and only ever moves the watermark
 * forward.
 *
 * The store is module-scoped, so each test uses its own channel name.
 */

import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';

import { loadConversation, saveMessages } from '../message-store';

const message = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

describe('message store', () => {
  it('reports an empty conversation for a channel it has never seen', () => {
    const stored = loadConversation('ai:unknown');

    expect(stored.messages).toEqual([]);
    expect(stored.latestSerial).toBeUndefined();
  });

  it('saves the messages and the serial they are complete up to', async () => {
    const messages = [message('u1', 'hello')];

    await saveMessages('ai:saved', messages, 's-1');

    expect(loadConversation('ai:saved')).toEqual({ messages, latestSerial: 's-1' });
  });

  it('replaces the messages wholesale, as the AI SDK hands back the whole conversation', async () => {
    await saveMessages('ai:replaced', [message('u1', 'hello')], 's-1');
    const whole = [message('u1', 'hello'), message('u2', 'again')];

    await saveMessages('ai:replaced', whole, 's-2');

    expect(loadConversation('ai:replaced')).toEqual({ messages: whole, latestSerial: 's-2' });
  });

  it('leaves the watermark where it is when a write reports none', async () => {
    await saveMessages('ai:no-serial', [message('u1', 'hello')], 's-1');

    await saveMessages('ai:no-serial', [message('u1', 'hello'), message('u2', 'again')]);

    expect(loadConversation('ai:no-serial').latestSerial).toBe('s-1');
  });

  it('never moves the watermark backwards, so a retried write cannot skip messages', async () => {
    await saveMessages('ai:watermark', [message('u1', 'hello'), message('u2', 'again')], 's-2');

    await saveMessages('ai:watermark', [message('u1', 'hello')], 's-1');

    expect(loadConversation('ai:watermark').latestSerial).toBe('s-2');
  });

  it('takes the watermark from the first write for a fresh conversation', async () => {
    await saveMessages('ai:fresh', [message('u1', 'hello')], 's-5');

    expect(loadConversation('ai:fresh').latestSerial).toBe('s-5');
  });
});
