import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type * as AI from 'ai';

// jsdom does not implement Element.prototype.scrollIntoView; stub it so any
// library that calls it during layout is a no-op.
Element.prototype.scrollIntoView = () => {};

import { MessageList } from '../message-list';

function msg(id: string, role: 'user' | 'assistant', parts: AI.UIMessage['parts']): AI.UIMessage {
  return { id, role, parts };
}

afterEach(() => {
  cleanup();
});

// This demo is deliberately linear (no branch navigation or history pagination),
// so the list's job is just: intro when empty, one row per message otherwise,
// and the streaming state wired through to the bubble.
describe('MessageList (linear DB demo)', () => {
  it('shows the intro and no transcript scroller for an empty conversation', () => {
    render(
      <MessageList
        messages={[]}
        stateOf={() => undefined}
        scrollToEndRef={{ current: null }}
      />,
    );

    expect(screen.queryByTestId('messages')).toBeNull();
  });

  it('renders one row per message once the conversation has content', () => {
    const messages = [
      msg('m1', 'user', [{ type: 'text', text: 'first' }]),
      msg('m2', 'assistant', [{ type: 'text', text: 'reply' }]),
    ];
    render(
      <MessageList
        messages={messages}
        stateOf={() => undefined}
        scrollToEndRef={{ current: null }}
      />,
    );

    expect(screen.getAllByTestId('message')).toHaveLength(2);
  });

  it('keeps the walkthrough intro visible once messages exist', () => {
    const messages = [msg('m1', 'user', [{ type: 'text', text: 'first' }])];
    render(
      <MessageList
        messages={messages}
        stateOf={() => undefined}
        scrollToEndRef={{ current: null }}
      />,
    );

    expect(screen.getByText('useChat over Ably — database hydration')).toBeTruthy();
  });

  it('drives the thinking loader from stateOf for the streaming assistant turn', () => {
    const messages = [msg('m1', 'user', [{ type: 'text', text: 'q' }]), msg('m2', 'assistant', [])];
    render(
      <MessageList
        messages={messages}
        stateOf={(m) => (m.id === 'm2' ? 'streaming' : undefined)}
        scrollToEndRef={{ current: null }}
      />,
    );

    expect(screen.getByText(/Thinking/)).toBeTruthy();
  });
  it('keeps the transcript mounted across a transient empty emission', () => {
    const messages = [msg('m1', 'user', [{ type: 'text', text: 'first' }])];
    const { container, rerender } = render(
      <MessageList
        messages={messages}
        stateOf={() => undefined}
        scrollToEndRef={{ current: null }}
      />,
    );

    rerender(
      <MessageList
        messages={[]}
        stateOf={() => undefined}
        scrollToEndRef={{ current: null }}
      />,
    );

    expect(container.querySelector('[data-testid="message-viewport"]')).toBeTruthy();
  });
  it('follows a tool-part update on an earlier message while pinned', () => {
    const messages = [
      msg('m1', 'user', [{ type: 'text', text: 'first' }]),
      msg('m2', 'assistant', [{ type: 'text', text: 'reply' }]),
    ];
    const { container, rerender } = render(
      <MessageList
        messages={messages}
        stateOf={() => undefined}
        scrollToEndRef={{ current: null }}
      />,
    );
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
    const changed = [msg('m1', 'user', [{ type: 'text', text: 'first, now with output' }]), messages[1]];
    rerender(
      <MessageList
        messages={changed}
        stateOf={() => undefined}
        scrollToEndRef={{ current: null }}
      />,
    );

    expect(viewport.scrollTop).toBe(1000);
  });

  it('stops following once the reader scrolls away from the bottom', () => {
    const messages = [
      msg('m1', 'user', [{ type: 'text', text: 'first' }]),
      msg('m2', 'assistant', [{ type: 'text', text: 'reply' }]),
    ];
    const { container, rerender } = render(
      <MessageList
        messages={messages}
        stateOf={() => undefined}
        scrollToEndRef={{ current: null }}
      />,
    );
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
        messages={[...messages]}
        stateOf={() => undefined}
        scrollToEndRef={{ current: null }}
      />,
    );

    expect(viewport.scrollTop).toBe(100);
  });
});
