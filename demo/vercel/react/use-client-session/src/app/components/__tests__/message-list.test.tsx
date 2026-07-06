import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type * as AI from 'ai';
import type { BranchHandle, CodecMessage } from '@ably/ai-transport';

// jsdom lacks scrollIntoView; the MessageScroller calls it as the list grows.
Element.prototype.scrollIntoView = () => {};

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

// Position the scroller's viewport and fire a scroll event, the way a reader
// scrolling the transcript does.
function scrollViewportTo(container: HTMLElement, top: number) {
  const viewport = container.querySelector('[data-slot="message-scroller-viewport"]');
  expect(viewport).toBeTruthy();
  if (!viewport) return;
  viewport.scrollTop = top;
  fireEvent.scroll(viewport);
}

describe('MessageList history loading', () => {
  afterEach(() => {
    cleanup();
  });

  it('requests an older page when the reader scrolls to the very top', () => {
    const onLoadOlder = vi.fn();
    const { container } = renderList({ hasOlder: true, loading: false, onLoadOlder });

    scrollViewportTo(container, 0);

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not request while the reader is below the top edge', () => {
    const onLoadOlder = vi.fn();
    const { container } = renderList({ hasOlder: true, loading: false, onLoadOlder });

    scrollViewportTo(container, 400);

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('does not request while an older page is already loading', () => {
    const onLoadOlder = vi.fn();
    const { container } = renderList({ hasOlder: true, loading: true, onLoadOlder });

    scrollViewportTo(container, 0);

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('does not request when there is no older history', () => {
    const onLoadOlder = vi.fn();
    const { container } = renderList({ hasOlder: false, loading: false, onLoadOlder });

    scrollViewportTo(container, 0);

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('keeps the walkthrough intro visible once messages exist', () => {
    renderList({ hasOlder: false, loading: false, onLoadOlder: vi.fn() });

    expect(screen.getByText('ClientSession over Ably')).toBeTruthy();
  });
});
