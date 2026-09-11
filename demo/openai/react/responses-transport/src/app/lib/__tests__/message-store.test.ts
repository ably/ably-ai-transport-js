/**
 * Tests for the demo's server-owned conversation store: it holds the merged
 * thread — messages, no wire events and no run state — plus the channel serial
 * they are complete up to, folds each write in by `transportMessageId`, and
 * only ever moves the watermark forward.
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
  ...(latestSerial === undefined ? {} : { latestSerial }),
});

describe('message store', () => {
  it('reports an empty conversation for a channel it has never seen', () => {
    const stored = loadConversation('ai:unknown');

    expect(stored.messages).toEqual([]);
  });

  it('holds the merged messages and the serial they are complete up to', async () => {
    const stored = conversation([message('cm-1', 'hello')], 's-1');

    await saveConversation('ai:saved', stored);

    expect(loadConversation('ai:saved')).toEqual(stored);
  });

  it('never moves the watermark backwards, so a retried write cannot skip messages', async () => {
    await saveConversation('ai:watermark', conversation([message('cm-1', 'a'), message('cm-2', 'b')], 's-2'));

    await saveConversation('ai:watermark', conversation([message('cm-1', 'a')], 's-1'));

    expect(loadConversation('ai:watermark').latestSerial).toBe('s-2');
  });

  it('leaves the watermark where it is when a write reports none', async () => {
    await saveConversation('ai:no-serial', conversation([message('cm-1', 'a')], 's-1'));

    await saveConversation('ai:no-serial', conversation([message('cm-1', 'a'), message('cm-2', 'b')]));

    expect(loadConversation('ai:no-serial').latestSerial).toBe('s-1');
  });

  it('takes the incoming version of a message it already holds', async () => {
    await saveConversation('ai:replaced', conversation([message('cm-1', 'hello')]));
    const whole = conversation([message('cm-1', 'hello, again'), message('cm-2', 'and more')]);

    await saveConversation('ai:replaced', whole);

    expect(loadConversation('ai:replaced')).toEqual(whole);
  });

  it('keeps a message a later write never saw, so an overlapping turn cannot drop it', async () => {
    // Two turns overlap: answering a gated tool call wakes a second run while
    // the first is still finishing its write, so the second seeded from a
    // store the first had not written to yet. Replacing wholesale would drop
    // the first turn's message and leave the model a tool output whose call
    // had vanished.
    await saveConversation('ai:overlap', conversation([message('cm-1', 'prompt')]));
    await saveConversation('ai:overlap', conversation([message('cm-1', 'prompt'), message('cm-2', 'the call')]));

    await saveConversation('ai:overlap', conversation([message('cm-1', 'prompt'), message('cm-3', 'the answer')]));

    expect(loadConversation('ai:overlap').messages.map((m) => m.transportMessageId)).toEqual(['cm-1', 'cm-2', 'cm-3']);
  });
});
