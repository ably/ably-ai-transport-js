/**
 * Tests for the demo's server-owned conversation store: it holds the merged
 * thread (not wire events), replaces it wholesale on the next write, and
 * ignores a write whose watermark has gone backwards.
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

const conversation = (messages: ThreadMessage[], latestSerial?: string): StoredConversation => ({
  messages,
  runs: [],
  ...(latestSerial === undefined ? {} : { latestSerial }),
});

describe('message store', () => {
  it('reports an empty conversation for a channel it has never seen', () => {
    const stored = loadConversation('ai:unknown');

    expect(stored.messages).toEqual([]);
    expect(stored.runs).toEqual([]);
    expect(stored.latestSerial).toBeUndefined();
  });

  it('holds the merged messages and the serial they are complete up to', async () => {
    const stored = conversation([message('cm-1', 'hello')], 's-1');

    await saveConversation('ai:saved', stored);

    expect(loadConversation('ai:saved')).toEqual(stored);
  });

  it('holds the run summaries alongside the messages', async () => {
    const stored: StoredConversation = {
      messages: [message('cm-1', 'hello')],
      runs: [['run-1', { status: 'complete' }]],
      latestSerial: 's-1',
    };

    await saveConversation('ai:runs', stored);

    expect(loadConversation('ai:runs').runs).toEqual([['run-1', { status: 'complete' }]]);
  });

  it('replaces the conversation wholesale on the next write', async () => {
    await saveConversation('ai:replaced', conversation([message('cm-1', 'hello')], 's-1'));
    const later = conversation([message('cm-1', 'hello'), message('cm-2', 'again')], 's-2');

    await saveConversation('ai:replaced', later);

    expect(loadConversation('ai:replaced')).toEqual(later);
  });

  it('ignores a write whose watermark is older than the stored one', async () => {
    const held = conversation([message('cm-1', 'hello'), message('cm-2', 'again')], 's-2');
    await saveConversation('ai:stale', held);

    await saveConversation('ai:stale', conversation([message('cm-1', 'hello')], 's-1'));

    expect(loadConversation('ai:stale')).toEqual(held);
  });

  it('ignores a write carrying no watermark once one is stored', async () => {
    const held = conversation([message('cm-1', 'hello')], 's-1');
    await saveConversation('ai:no-watermark', held);

    await saveConversation('ai:no-watermark', conversation([]));

    expect(loadConversation('ai:no-watermark')).toEqual(held);
  });

  it('accepts a write at the same watermark, which is how a re-write lands', async () => {
    await saveConversation('ai:rewrite', conversation([message('cm-1', 'hello')], 's-1'));
    const again = conversation([message('cm-1', 'edited')], 's-1');

    await saveConversation('ai:rewrite', again);

    expect(loadConversation('ai:rewrite')).toEqual(again);
  });
});
