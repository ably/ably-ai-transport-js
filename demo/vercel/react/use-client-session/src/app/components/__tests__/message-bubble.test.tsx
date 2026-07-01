import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { MessageBubble } from '../message-bubble';

// MessageBubble is a pure renderer: the list glue (MessageList) derives the
// per-message step attribution from the View's `run.steps` and passes it as the
// primitive `stepId` / `stepCount` props. These tests pin the step badge that
// surfaces that attribution beside the run id.

const assistantMessage: UIMessage = {
  id: 'm1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'hello' }],
};

const baseProps = {
  message: assistantMessage,
  codecMessageId: 'cm1',
  clientId: 'agent',
  runId: 'run-1',
  status: 'complete' as const,
  hasSiblings: false,
  siblingCount: 1,
  selectedIndex: 0,
  onSelectSibling: () => {},
};

describe('<MessageBubble> step badge', () => {
  afterEach(cleanup);

  it('renders the step badge with the truncated step id', () => {
    render(
      <MessageBubble
        {...baseProps}
        stepId="abcdef0123456789"
        stepCount={1}
      />,
    );

    // The badge shows the first 8 chars of the step id; a single-step run has no
    // overflow suffix.
    expect(screen.getByText('step')).not.toBeNull();
    expect(screen.getByText('abcdef01')).not.toBeNull();
  });

  it('appends a "+N" suffix when the run has more than one step', () => {
    render(
      <MessageBubble
        {...baseProps}
        stepId="abcdef0123456789"
        stepCount={3}
      />,
    );

    // Three steps on the run: the bubble names its last step and tallies the
    // other two as "+2".
    expect(screen.getByText('abcdef01 +2')).not.toBeNull();
  });

  it('renders no step badge when the message carries no step id', () => {
    render(
      <MessageBubble
        {...baseProps}
        stepId={undefined}
        stepCount={0}
      />,
    );

    expect(screen.queryByText('step')).toBeNull();
  });
});
