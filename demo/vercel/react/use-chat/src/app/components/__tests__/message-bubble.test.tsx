import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type * as AI from 'ai';

import { MessageBubble } from '../message-bubble';

// The bubble shows a quiet "Thinking…" loader for an assistant turn that is
// streaming but has produced no text or tool activity yet (replacing the old
// blinking caret). These tests pin that branch and its suppressions.

afterEach(() => {
  cleanup();
});

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
  it('renders the run, step, and status badges once the owning run is known', () => {
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

    // The debug badges render only once the message's owning Run is known.
    expect(screen.getByText('run')).toBeTruthy();
    expect(screen.getByText('2195f39c')).toBeTruthy();
    expect(screen.getByText('step')).toBeTruthy();
    expect(screen.getByText('7bd73ec9')).toBeTruthy();
    expect(screen.getByText('status')).toBeTruthy();
    expect(screen.getByText('complete')).toBeTruthy();
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
  });
});
