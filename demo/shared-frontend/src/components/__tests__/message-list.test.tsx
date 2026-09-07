import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import type { UIMessage } from 'ai';

// jsdom has no layout; stub scrollIntoView so any library that calls it during
// layout is a no-op.
Element.prototype.scrollIntoView = () => {};

import { LinearMessageList } from '../message-list';

afterEach(cleanup);

function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

const messages = [msg('m1', 'user', 'first'), msg('m2', 'assistant', 'reply')];

// Render the default two-message transcript, with the few knobs each test needs.
function renderList(opts: { hasOlder?: boolean; onLoadOlder?: () => void } = {}) {
  return render(
    <LinearMessageList
      messages={messages}
      statusOf={() => undefined}
      hasOlder={opts.hasOlder}
      onLoadOlder={opts.onLoadOlder}
      scrollToEndRef={createRef<(() => void) | null>()}
      introTitle="Test Intro"
    />,
  );
}

describe('<LinearMessageList> history loading', () => {
  it('renders the Load older button and requests an older page on click', () => {
    const onLoadOlder = vi.fn();
    renderList({ hasOlder: true, onLoadOlder });
    fireEvent.click(screen.getByTestId('load-older'));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('renders no Load older button when there is no older history', () => {
    renderList({ hasOlder: false, onLoadOlder: () => {} });
    expect(screen.queryByTestId('load-older')).toBeNull();
  });

  it('renders no Load older button without an onLoadOlder handler', () => {
    renderList({ hasOlder: true });
    expect(screen.queryByTestId('load-older')).toBeNull();
  });

  it('keeps the walkthrough intro visible above the Load older affordance', () => {
    renderList({ hasOlder: true, onLoadOlder: () => {} });
    expect(screen.getByText('Test Intro')).toBeTruthy();
    expect(screen.getByTestId('load-older')).toBeTruthy();
  });
});
