import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { createRef } from 'react';
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';
import { LinearMessageList } from '../message-list';
import type { MessageStatus } from '../message-bubble';

afterEach(cleanup);

function textMessage(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] } as UIMessage;
}

const noStatus = (): MessageStatus | undefined => undefined;

describe('LinearMessageList', () => {
  it('renders the intro card and no messages when empty', () => {
    render(
      <LinearMessageList
        messages={[]}
        statusOf={noStatus}
        scrollToEndRef={createRef<(() => void) | null>()}
      />,
    );
    expect(screen.queryAllByTestId('message')).toHaveLength(0);
    // The intro card's default heading is shown.
    expect(screen.getByText('ClientSession over Ably')).toBeTruthy();
  });

  it('renders each message in a role/id/state-tagged wrapper around a bubble', () => {
    render(
      <LinearMessageList
        messages={[textMessage('u1', 'user', 'hi'), textMessage('a1', 'assistant', 'hello')]}
        statusOf={(_m, i) => (i === 1 ? 'complete' : undefined)}
        scrollToEndRef={createRef<(() => void) | null>()}
      />,
    );
    const rows = screen.getAllByTestId('message');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-role')).toBe('user');
    expect(rows[0].getAttribute('data-id')).toBe('u1');
    expect(rows[1].getAttribute('data-role')).toBe('assistant');
    expect(rows[1].getAttribute('data-state')).toBe('complete');
    // The shared bubble renders inside each wrapper.
    expect(within(rows[1]).getByTestId('message-bubble')).toBeTruthy();
  });

  it('shows the streaming "Thinking…" loader for an empty streaming assistant turn', () => {
    render(
      <LinearMessageList
        messages={[textMessage('u1', 'user', 'hi'), textMessage('a1', 'assistant', '')]}
        statusOf={(_m, i) => (i === 1 ? 'streaming' : undefined)}
        scrollToEndRef={createRef<(() => void) | null>()}
      />,
    );
    expect(screen.getByText('Thinking…')).toBeTruthy();
  });

  it('passes the tool part to onToolApprove / onToolDeny', () => {
    const onToolApprove = vi.fn();
    const onToolDeny = vi.fn();
    const toolPart = {
      type: 'tool-getWeatherForecast',
      toolCallId: 'call-1',
      state: 'approval-requested',
      input: { location: 'London' },
      approval: { id: 'appr-1' },
    } as unknown as ToolUIPart;
    const message = { id: 'a1', role: 'assistant', parts: [toolPart] } as UIMessage;

    render(
      <LinearMessageList
        messages={[message]}
        statusOf={noStatus}
        onToolApprove={onToolApprove}
        onToolDeny={onToolDeny}
        scrollToEndRef={createRef<(() => void) | null>()}
      />,
    );

    // Scope to the approval card's buttons — the intro card's walkthrough text
    // also mentions "Approve".
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onToolApprove).toHaveBeenCalledTimes(1);
    const approved = onToolApprove.mock.calls[0][0] as ToolUIPart | DynamicToolUIPart;
    expect(approved.toolCallId).toBe('call-1');

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onToolDeny).toHaveBeenCalledTimes(1);
  });

  it('keeps the transcript rendered after messages briefly empty mid-flow', () => {
    const ref = createRef<(() => void) | null>();
    const { rerender } = render(
      <LinearMessageList
        messages={[textMessage('u1', 'user', 'hi')]}
        statusOf={noStatus}
        scrollToEndRef={ref}
      />,
    );
    expect(screen.getAllByTestId('message')).toHaveLength(1);
    // A transient empty re-emission must not flip back to the intro-only state.
    rerender(
      <LinearMessageList
        messages={[]}
        statusOf={noStatus}
        scrollToEndRef={ref}
      />,
    );
    expect(screen.getByTestId('messages')).toBeTruthy();
  });
});
