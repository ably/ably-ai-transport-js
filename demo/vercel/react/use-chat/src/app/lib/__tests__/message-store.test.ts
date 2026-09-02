/**
 * Tests for the demo's server-owned conversation store: it replaces a
 * channel's messages wholesale, tracks the run open on that channel
 * independently, and reports an empty conversation for a channel it has never
 * seen.
 *
 * The store is module-scoped, so each test uses its own channel name.
 */

import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';

import { loadConversation, saveMessages, setActiveRun } from '../message-store';

const message = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

describe('message store', () => {
  it('reports an empty conversation for a channel it has never seen', () => {
    const stored = loadConversation('ai:unknown');

    expect(stored.messages).toEqual([]);
    expect(stored.activeRunId).toBeUndefined();
  });

  it('saves and loads a conversation', async () => {
    const messages = [message('u1', 'hello')];

    await saveMessages('ai:saved', messages);

    expect(loadConversation('ai:saved').messages).toEqual(messages);
  });

  it('replaces the messages wholesale, as the AI SDK hands back the whole conversation', async () => {
    await saveMessages('ai:replaced', [message('u1', 'hello')]);
    const whole = [message('u1', 'hello'), message('u2', 'again')];

    await saveMessages('ai:replaced', whole);

    expect(loadConversation('ai:replaced').messages).toEqual(whole);
  });

  it('keeps the open run across a message write', async () => {
    await setActiveRun('ai:run-kept', 'run-1');

    await saveMessages('ai:run-kept', [message('u1', 'hello')]);

    expect(loadConversation('ai:run-kept')).toEqual({ messages: [message('u1', 'hello')], activeRunId: 'run-1' });
  });

  it('keeps the messages across an open-run write', async () => {
    await saveMessages('ai:messages-kept', [message('u1', 'hello')]);

    await setActiveRun('ai:messages-kept', 'run-1');

    expect(loadConversation('ai:messages-kept').messages).toEqual([message('u1', 'hello')]);
  });

  it('clears the open run so a hydrating client resumes nothing that has ended', async () => {
    await setActiveRun('ai:run-cleared', 'run-1');

    await setActiveRun('ai:run-cleared', undefined);

    expect(loadConversation('ai:run-cleared').activeRunId).toBeUndefined();
  });

  it('records an open run for a channel with nothing stored yet', async () => {
    await setActiveRun('ai:fresh-run', 'run-1');

    expect(loadConversation('ai:fresh-run')).toEqual({ messages: [], activeRunId: 'run-1' });
  });
});
