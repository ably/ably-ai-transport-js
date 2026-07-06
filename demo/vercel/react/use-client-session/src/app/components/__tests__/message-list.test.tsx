import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type * as AI from 'ai';
import type { BranchHandle, CodecMessage } from '@ably/ai-transport';

// jsdom lacks scrollIntoView; the MessageScroller calls it as the list grows.
Element.prototype.scrollIntoView = () => {};

// MessageList has no onReachStart hook — it watches the scroller's visibility
// state and asks for an older page once the oldest message becomes visible.
// Drive that visibility deterministically by stubbing the hook, leaving the
// rest of the vendored scroller intact.
let visibleMessageIds: string[] = [];
vi.mock('@/components/ui/message-scroller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/message-scroller')>();
  return { ...actual, useMessageScrollerVisibility: () => ({ visibleMessageIds }) };
});

import { MessageList } from '../message-list';

const noBranch = (): BranchHandle<AI.UIMessage> => ({
  hasSiblings: false,
  siblings: [],
  index: 0,
  selected: undefined,
  select: () => {},
});

function msg(id: string, role: 'user' | 'assistant', text: string): CodecMessage<AI.UIMessage> {
  return { codecMessageId: id, message: { id, role, parts: [{ type: 'text', text }] } };
}

const messages = [msg('m1', 'user', 'first'), msg('m2', 'assistant', 'reply')];

function renderList(opts: { hasOlder: boolean; loading: boolean; onLoadOlder: () => void }) {
  return render(
    <MessageList
      messages={messages}
      hasOlder={opts.hasOlder}
      loading={opts.loading}
      view={{ branchSelection: noBranch, runOf: () => undefined }}
      onLoadOlder={opts.onLoadOlder}
      onRegenerate={() => {}}
      onEdit={() => {}}
    />,
  );
}

describe('MessageList history auto-loading', () => {
  beforeEach(() => {
    visibleMessageIds = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('requests an older page when the oldest message scrolls into view', () => {
    visibleMessageIds = ['m1'];
    const onLoadOlder = vi.fn();
    renderList({ hasOlder: true, loading: false, onLoadOlder });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not request while an older page is already loading', () => {
    visibleMessageIds = ['m1'];
    const onLoadOlder = vi.fn();
    renderList({ hasOlder: true, loading: true, onLoadOlder });

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('does not request when there is no older history', () => {
    visibleMessageIds = ['m1'];
    const onLoadOlder = vi.fn();
    renderList({ hasOlder: false, loading: false, onLoadOlder });

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('keeps the walkthrough intro visible once messages exist', () => {
    renderList({ hasOlder: false, loading: false, onLoadOlder: vi.fn() });

    expect(screen.getByText('ClientSession over Ably')).toBeTruthy();
  });
});
