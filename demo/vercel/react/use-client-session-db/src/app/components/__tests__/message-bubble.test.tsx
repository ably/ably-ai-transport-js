import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type * as AI from 'ai';

import { MessageBubble } from '../message-bubble';

// The bubble shows a quiet "Thinking…" loader for an assistant turn whose run
// is streaming but has produced no text or tool activity yet. These tests pin
// that branch and its suppressions.

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
        status="streaming"
      />,
    );

    expect(screen.getByText(/Thinking/)).toBeTruthy();
  });

  it('hides the loader once the streaming turn has text', () => {
    render(
      <MessageBubble
        message={assistant([{ type: 'text', text: 'partial' }])}
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
        status="streaming"
      />,
    );

    expect(screen.queryByText(/Thinking/)).toBeNull();
  });
});
