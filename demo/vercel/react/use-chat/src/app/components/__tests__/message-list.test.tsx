import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type * as AI from 'ai';
import type { BranchHandle, CodecMessage } from '@ably/ai-transport';

// jsdom does not implement Element.prototype.scrollIntoView; stub it so any
// library that calls it during layout is a no-op.
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

function listProps(opts: { hasOlder: boolean; loading: boolean; onLoadOlder: () => void }) {
  return {
    messages,
    hasOlder: opts.hasOlder,
    loading: opts.loading,
    view: { branchSelection: noBranch, runOf: () => undefined },
    onLoadOlder: opts.onLoadOlder,
    onRegenerate: () => {},
    onEdit: () => {},
    scrollToEndRef: { current: null },
  };
}

function renderList(opts: { hasOlder: boolean; loading: boolean; onLoadOlder: () => void }) {
  return render(<MessageList {...listProps(opts)} />);
}

// Position the scroller's viewport and fire a scroll event, the way a reader
// scrolling the transcript does.
function scrollViewportTo(container: HTMLElement, top: number) {
  const viewport = container.querySelector('[data-testid="message-viewport"]');
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

    expect(screen.getByText('useChat over Ably')).toBeTruthy();
  });

  it('keeps the transcript mounted across a transient empty emission', () => {
    const props = listProps({ hasOlder: false, loading: false, onLoadOlder: vi.fn() });
    const { container, rerender } = render(<MessageList {...props} />);

    rerender(
      <MessageList
        {...props}
        messages={[]}
      />,
    );

    expect(container.querySelector('[data-testid="message-viewport"]')).toBeTruthy();
  });

  it('follows a tool-part update on an earlier message while pinned', () => {
    const props = listProps({ hasOlder: false, loading: false, onLoadOlder: vi.fn() });
    const { container, rerender } = render(<MessageList {...props} />);
    const viewport = container.querySelector('[data-testid="message-viewport"]');
    expect(viewport).toBeTruthy();
    if (!viewport) return;

    // Give the zero-size jsdom viewport real dimensions, then move it off the
    // bottom WITHOUT a scroll event so the pin is untouched.
    Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true });
    viewport.scrollTop = 50;

    // The newest message is unchanged; an earlier message's parts change (the
    // shape of an approval's tool output landing) — the view must still follow.
    const changed = [msg('m1', 'user', 'first, now with output'), messages[1]];
    rerender(
      <MessageList
        {...props}
        messages={changed}
      />,
    );

    expect(viewport.scrollTop).toBe(1000);
  });

  it('stops following once the reader scrolls away from the bottom', () => {
    const props = listProps({ hasOlder: false, loading: false, onLoadOlder: vi.fn() });
    const { container, rerender } = render(<MessageList {...props} />);
    const viewport = container.querySelector('[data-testid="message-viewport"]');
    expect(viewport).toBeTruthy();
    if (!viewport) return;

    // Give the zero-size jsdom viewport real dimensions. Settle at the bottom
    // first so the pin is engaged, then scroll UP — only a decrease in
    // scrollTop releases the pin (content growing below never does).
    Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true });
    viewport.scrollTop = 700;
    fireEvent.scroll(viewport);
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);

    rerender(
      <MessageList
        {...props}
        messages={[...messages]}
      />,
    );

    expect(viewport.scrollTop).toBe(100);
  });
});
