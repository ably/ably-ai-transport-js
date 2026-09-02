/**
 * Tests for the demo's server-owned conversation store: it holds the merged
 * thread (not wire events) with its run summaries, and replaces it wholesale
 * on the next write.
 *
 * The store is module-scoped, so each test uses its own channel name.
 */

import { describe, expect, it } from 'vitest';

import { loadConversation, saveConversation, type StoredConversation } from '../message-store';
import type { ThreadMessage } from '../merge-thread';

const message = (transportMessageId: string, text: string): ThreadMessage => ({
  transportMessageId,
  role: 'user',
  items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
});

const conversation = (messages: ThreadMessage[]): StoredConversation => ({ messages, runs: [] });

describe('message store', () => {
  it('reports an empty conversation for a channel it has never seen', () => {
    const stored = loadConversation('ai:unknown');

    expect(stored.messages).toEqual([]);
    expect(stored.runs).toEqual([]);
  });

  it('holds the merged messages', async () => {
    const stored = conversation([message('cm-1', 'hello')]);

    await saveConversation('ai:saved', stored);

    expect(loadConversation('ai:saved')).toEqual(stored);
  });

  it('holds the run summaries alongside the messages', async () => {
    const stored: StoredConversation = {
      messages: [message('cm-1', 'hello')],
      runs: [['run-1', { status: 'complete' }]],
    };

    await saveConversation('ai:runs', stored);

    expect(loadConversation('ai:runs').runs).toEqual([['run-1', { status: 'complete' }]]);
  });

  it('replaces the conversation wholesale, because the writer holds all of it', async () => {
    await saveConversation('ai:replaced', conversation([message('cm-1', 'hello')]));
    const whole = conversation([message('cm-1', 'hello'), message('cm-2', 'again')]);

    await saveConversation('ai:replaced', whole);

    expect(loadConversation('ai:replaced')).toEqual(whole);
  });
});
