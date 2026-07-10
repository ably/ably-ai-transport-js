import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type * as AI from 'ai';
import type { BranchHandle, CodecMessage } from '@ably/ai-transport';

// jsdom has no layout; stub scrollIntoView so any library that calls it during
// layout is a no-op.
Element.prototype.scrollIntoView = () => {};

import { BranchingMessageList } from '../message-list';
import { TooltipProvider } from '../ui/tooltip';

afterEach(cleanup);

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

// Render the default two-message transcript, with the few knobs each test needs.
function renderList(opts: { hasOlder?: boolean; loading?: boolean; onLoadOlder?: () => void } = {}) {
  return render(
    <BranchingMessageList
      messages={messages}
      hasOlder={opts.hasOlder ?? false}
      loading={opts.loading ?? false}
      view={{ branchSelection: noBranch, runOf: () => undefined }}
      onLoadOlder={opts.onLoadOlder ?? (() => {})}
      onRegenerate={() => {}}
      onEdit={() => {}}
      scrollToEndRef={{ current: null }}
      introTitle="Test Intro"
    />,
  );
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

describe('<BranchingMessageList> history loading', () => {
  it('requests an older page when the reader scrolls to the very top', () => {
    const onLoadOlder = vi.fn();
    const { container } = renderList({ hasOlder: true, onLoadOlder });
    scrollViewportTo(container, 0);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not request while the reader is below the top edge', () => {
    const onLoadOlder = vi.fn();
    const { container } = renderList({ hasOlder: true, onLoadOlder });
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
    const { container } = renderList({ hasOlder: false, onLoadOlder });
    scrollViewportTo(container, 0);
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('requests an older page when the Load older button is clicked', () => {
    const onLoadOlder = vi.fn();
    renderList({ hasOlder: true, onLoadOlder });
    fireEvent.click(screen.getByTestId('load-older'));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});

describe('<BranchingMessageList> transcript', () => {
  it('keeps the walkthrough intro visible once messages exist', () => {
    renderList();
    expect(screen.getByText('Test Intro')).toBeTruthy();
  });

  it('keeps the transcript mounted across a transient empty emission', () => {
    const { container, rerender } = renderList();
    rerender(
      <BranchingMessageList
        messages={[]}
        hasOlder={false}
        loading={false}
        view={{ branchSelection: noBranch, runOf: () => undefined }}
        onLoadOlder={() => {}}
        onRegenerate={() => {}}
        onEdit={() => {}}
        scrollToEndRef={{ current: null }}
        introTitle="Test Intro"
      />,
    );
    expect(container.querySelector('[data-testid="message-viewport"]')).toBeTruthy();
  });
});

describe('<BranchingMessageList> branch navigation', () => {
  it('renders the navigator and selects the next sibling', () => {
    const select = vi.fn();
    const sib: AI.UIMessage = { id: 's', role: 'assistant', parts: [{ type: 'text', text: 'x' }] };
    const branchSelection = (): BranchHandle<AI.UIMessage> => ({
      hasSiblings: true,
      siblings: [sib, sib],
      index: 0,
      selected: sib,
      select,
    });

    render(
      <TooltipProvider>
        <BranchingMessageList
          messages={[msg('m2', 'assistant', 'reply')]}
          hasOlder={false}
          loading={false}
          view={{ branchSelection, runOf: () => undefined }}
          onLoadOlder={() => {}}
          onRegenerate={() => {}}
          onEdit={() => {}}
          scrollToEndRef={{ current: null }}
        />
      </TooltipProvider>,
    );

    expect(screen.getByTestId('branch-counter').textContent).toContain('1 / 2');
    fireEvent.click(screen.getByRole('button', { name: 'Next branch' }));
    expect(select).toHaveBeenCalledWith(1);
  });
});

describe('<BranchingMessageList> tool approval', () => {
  it('passes the codec message and tool part to onToolApprove / onToolDeny', () => {
    const onToolApprove = vi.fn();
    const onToolDeny = vi.fn();
    // CAST: `ToolUIPart` is a discriminated union keyed on `state`; build the
    // approval-requested fixture the tool card reads (its `approval.id` completes
    // that arm) and assert the union type.
    const toolPart = {
      type: 'tool-getWeatherForecast',
      toolCallId: 'tc1',
      state: 'approval-requested',
      input: { location: 'London' },
      approval: { id: 'ap1' },
    } as AI.ToolUIPart;
    const approvalMsg: CodecMessage<AI.UIMessage> = {
      codecMessageId: 'a1',
      message: { id: 'a1', role: 'assistant', parts: [toolPart] },
    };

    render(
      <BranchingMessageList
        messages={[approvalMsg]}
        hasOlder={false}
        loading={false}
        view={{ branchSelection: noBranch, runOf: () => undefined }}
        onLoadOlder={() => {}}
        onRegenerate={() => {}}
        onEdit={() => {}}
        onToolApprove={onToolApprove}
        onToolDeny={onToolDeny}
        scrollToEndRef={{ current: null }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onToolApprove).toHaveBeenCalledWith(approvalMsg, toolPart);

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onToolDeny).toHaveBeenCalledWith(approvalMsg, toolPart);
  });
});
