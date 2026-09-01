import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { appendMessages, loadConversation } from '../message-store';

function msg(id: string, role: UIMessage['role'], text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

// Each test uses a distinct conversation id — the store is module-scoped and
// shared across the file.
describe('message-store', () => {
  it('loads [] for an unknown conversation', () => {
    expect(loadConversation('unknown')).toEqual({ messages: [] });
  });

  it('appends turns and returns them oldest-first', async () => {
    await appendMessages('c1', [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello')]);
    await appendMessages('c1', [msg('u2', 'user', 'again'), msg('a2', 'assistant', 'hey')]);

    expect(loadConversation('c1').messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('is idempotent by domain id — re-persisting a run does not duplicate', async () => {
    const turn = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello')];
    await appendMessages('c2', turn);
    await appendMessages('c2', turn);

    expect(loadConversation('c2').messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('upserts an existing id in place, preserving order and taking the new value', async () => {
    await appendMessages('c3', [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'first')]);
    // A continuation re-persists the assistant message with more content.
    await appendMessages('c3', [msg('a1', 'assistant', 'first and second')]);

    const stored = loadConversation('c3').messages;
    expect(stored.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(stored[1].parts).toEqual([{ type: 'text', text: 'first and second' }]);
  });

  it('keeps conversations isolated by key', async () => {
    await appendMessages('c4', [msg('u1', 'user', 'a')]);
    await appendMessages('c5', [msg('u9', 'user', 'b')]);

    expect(loadConversation('c4').messages.map((m) => m.id)).toEqual(['u1']);
    expect(loadConversation('c5').messages.map((m) => m.id)).toEqual(['u9']);
  });

  it('advances the stored serial as turns land, and never moves it backwards', async () => {
    await appendMessages('c6', [msg('u1', 'user', 'hi')], '01ABC@1');
    expect(loadConversation('c6').latestSerial).toBe('01ABC@1');

    await appendMessages('c6', [msg('a1', 'assistant', 'hello')], '01ABC@9');
    expect(loadConversation('c6').latestSerial).toBe('01ABC@9');

    // A retried or out-of-order persist must not rewind the watermark, or
    // hydration would re-walk history it has already accounted for.
    await appendMessages('c6', [msg('a1', 'assistant', 'hello')], '01ABC@2');
    expect(loadConversation('c6').latestSerial).toBe('01ABC@9');
  });

  it('leaves the serial unset when a turn is persisted without one', async () => {
    await appendMessages('c7', [msg('u1', 'user', 'hi')]);
    expect(loadConversation('c7').latestSerial).toBeUndefined();
  });
});
