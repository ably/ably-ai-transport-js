import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type * as AI from 'ai';

import { MessageBubble } from '../message-bubble';

// MessageBubble is a pure renderer: the list glue derives per-message run and
// step attribution from the app's own fold and passes it as primitive props. These tests
// pin the thinking loader, the debug badges (including the step badge), and the
// approval wiring that hands the tool part back to the container.

afterEach(cleanup);

function assistant(parts: AI.UIMessage['parts']): AI.UIMessage {
  return { id: 'a1', role: 'assistant', parts };
}

describe('<MessageBubble> thinking indicator', () => {
  it('shows the loader for a streaming assistant turn with no text or tools yet', () => {
    render(
      <MessageBubble
        message={assistant([])}
        clientId={undefined}
        runId={undefined}
        stepId={undefined}
        stepCount={0}
        status="streaming"
      />,
    );

    expect(screen.getByText(/Thinking/)).toBeTruthy();
  });

  it('hides the loader once the streaming turn has text', () => {
    render(
      <MessageBubble
        message={assistant([{ type: 'text', text: 'partial' }])}
        clientId={undefined}
        runId={undefined}
        stepId={undefined}
        stepCount={0}
        status="streaming"
      />,
    );

    expect(screen.queryByText(/Thinking/)).toBeNull();
  });

  it('hides the loader while a tool is active (tool parts count as activity)', () => {
    // CAST: minimal dynamic-tool fixture — only the discriminant fields the
    // bubble reads (type, toolName, toolCallId, state, input) are populated.
    const toolPart = {
      type: 'dynamic-tool',
      toolName: 'getWeather',
      toolCallId: 'tc1',
      state: 'input-streaming',
      input: {},
    } as AI.DynamicToolUIPart;

    render(
      <MessageBubble
        message={assistant([toolPart])}
        clientId={undefined}
        runId={undefined}
        stepId={undefined}
        stepCount={0}
        status="streaming"
      />,
    );

    expect(screen.queryByText(/Thinking/)).toBeNull();
  });
});

describe('<MessageBubble> debug badges', () => {
  it('renders the run, client, step, and status badges once the owning run is known', () => {
    render(
      <MessageBubble
        message={assistant([{ type: 'text', text: 'the reply' }])}
        clientId="galaxy-saffron"
        runId="2195f39c-1111-2222-3333-444444444444"
        stepId="7bd73ec9-5555-6666-7777-888888888888"
        stepCount={1}
        status="complete"
      />,
    );

    expect(screen.getByText('run')).toBeTruthy();
    expect(screen.getByText('2195f39c')).toBeTruthy();
    expect(screen.getByText('client')).toBeTruthy();
    expect(screen.getByText('galaxy-saffron')).toBeTruthy();
    expect(screen.getByText('step')).toBeTruthy();
    expect(screen.getByText('7bd73ec9')).toBeTruthy();
    expect(screen.getByText('status')).toBeTruthy();
    expect(screen.getByText('complete')).toBeTruthy();
  });

  it('appends a "+N" suffix to the step badge when the run has more than one step', () => {
    render(
      <MessageBubble
        message={assistant([{ type: 'text', text: 'the reply' }])}
        clientId="agent"
        runId="run-1"
        stepId="abcdef0123456789"
        stepCount={3}
        status="complete"
      />,
    );

    expect(screen.getByText('abcdef01 +2')).toBeTruthy();
  });

  it('omits the debug badges when the message has no owning run', () => {
    render(
      <MessageBubble
        message={assistant([{ type: 'text', text: 'the reply' }])}
        clientId={undefined}
        runId={undefined}
        stepId={undefined}
        stepCount={0}
        status={undefined}
      />,
    );

    expect(screen.queryByText('run')).toBeNull();
    expect(screen.queryByText('status')).toBeNull();
    expect(screen.queryByText('step')).toBeNull();
  });
});

describe('<MessageBubble> tool approval wiring', () => {
  // CAST: `ToolUIPart` is a discriminated union keyed on `state`; build the
  // approval-requested fixture the tool card reads (its `approval.id` completes
  // that arm) and assert the union type.
  const approvalPart = {
    type: 'tool-getWeatherForecast',
    toolCallId: 'tc1',
    state: 'approval-requested',
    input: { location: 'London' },
    approval: { id: 'ap1' },
  } as AI.ToolUIPart;

  it('hands the tool part to onToolApprove when Approve is clicked', () => {
    const onToolApprove = vi.fn();
    const onToolDeny = vi.fn();
    render(
      <MessageBubble
        message={assistant([approvalPart])}
        clientId={undefined}
        runId={undefined}
        stepId={undefined}
        stepCount={0}
        status="suspended"
        onToolApprove={onToolApprove}
        onToolDeny={onToolDeny}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onToolApprove).toHaveBeenCalledWith(approvalPart);
  });

  it('hands the tool part to onToolDeny when Deny is clicked', () => {
    const onToolApprove = vi.fn();
    const onToolDeny = vi.fn();
    render(
      <MessageBubble
        message={assistant([approvalPart])}
        clientId={undefined}
        runId={undefined}
        stepId={undefined}
        stepCount={0}
        status="suspended"
        onToolApprove={onToolApprove}
        onToolDeny={onToolDeny}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onToolDeny).toHaveBeenCalledWith(approvalPart);
  });
});
