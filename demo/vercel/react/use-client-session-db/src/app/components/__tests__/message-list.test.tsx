import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type * as AI from 'ai';

// jsdom lacks scrollIntoView; the MessageScroller calls it as the list grows.
Element.prototype.scrollIntoView = () => {};

import { MessageList } from '../message-list';

function msg(id: string, role: 'user' | 'assistant', parts: AI.UIMessage['parts']): AI.UIMessage {
  return { id, role, parts };
}

afterEach(() => {
  cleanup();
});

// This demo is deliberately linear (no branch navigation or history pagination),
// so the list's job is just: intro when empty, one bubble per message otherwise,
// and the streaming status wired through to the bubble.
describe('MessageList (linear DB demo)', () => {
  it('shows the intro and no transcript scroller for an empty conversation', () => {
    render(
      <MessageList
        messages={[]}
        statusOf={() => undefined}
      />,
    );

    expect(screen.queryByTestId('messages')).toBeNull();
  });

  it('renders one bubble per message once the conversation has content', () => {
    const messages = [
      msg('m1', 'user', [{ type: 'text', text: 'first' }]),
      msg('m2', 'assistant', [{ type: 'text', text: 'reply' }]),
    ];
    render(
      <MessageList
        messages={messages}
        statusOf={() => undefined}
      />,
    );

    expect(screen.getAllByTestId('message-bubble')).toHaveLength(2);
  });

  it('drives the thinking loader from statusOf for the streaming assistant turn', () => {
    const messages = [msg('m1', 'user', [{ type: 'text', text: 'q' }]), msg('m2', 'assistant', [])];
    render(
      <MessageList
        messages={messages}
        statusOf={(m) => (m.id === 'm2' ? 'streaming' : undefined)}
      />,
    );

    expect(screen.getByText(/Thinking/)).toBeTruthy();
  });
});
