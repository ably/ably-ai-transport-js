import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { appendMessages, loadMessages } from '../message-store';

function msg(id: string, role: UIMessage['role'], text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

// Each test uses a distinct conversation id — the store is module-scoped and
// shared across the file.
describe('message-store', () => {
  it('loads [] for an unknown conversation', () => {
    expect(loadMessages('unknown')).toEqual([]);
  });

  it('appends turns and returns them oldest-first', async () => {
    await appendMessages('c1', [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello')]);
    await appendMessages('c1', [msg('u2', 'user', 'again'), msg('a2', 'assistant', 'hey')]);

    expect(loadMessages('c1').map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('is idempotent by domain id — re-persisting a run does not duplicate', async () => {
    const turn = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello')];
    await appendMessages('c2', turn);
    await appendMessages('c2', turn);

    expect(loadMessages('c2').map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('upserts an existing id in place, preserving order and taking the new value', async () => {
    await appendMessages('c3', [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'first')]);
    // A continuation re-persists the assistant message with more content.
    await appendMessages('c3', [msg('a1', 'assistant', 'first and second')]);

    const stored = loadMessages('c3');
    expect(stored.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(stored[1].parts).toEqual([{ type: 'text', text: 'first and second' }]);
  });

  it('keeps conversations isolated by key', async () => {
    await appendMessages('c4', [msg('u1', 'user', 'a')]);
    await appendMessages('c5', [msg('u9', 'user', 'b')]);

    expect(loadMessages('c4').map((m) => m.id)).toEqual(['u1']);
    expect(loadMessages('c5').map((m) => m.id)).toEqual(['u9']);
  });
});
