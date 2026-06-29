import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type * as AI from 'ai';

// ---------------------------------------------------------------------------
// Mock surface — SeededChat is glue over the session view and the SDK's
// useMessagesWithSeed seam walk. The mocks let us exercise the linear render,
// the send → wakeAgent path, and the run-state / Stop UI without an Ably client
// or the codec.
// ---------------------------------------------------------------------------

// Hoisted so the vi.mock factories below (which vitest lifts to the top of the
// file) can safely reference these mocks. `session` is a single stable object —
// the real provider memoizes it, and the seeded chat's run-state effect depends
// on `session.view`, so a fresh object per render would re-run it forever.
// `runsHolder.current` is the mutable run list each test sets before rendering.
const { mockSend, mockWakeAgent, mockCancel, runsHolder, session } = vi.hoisted(() => {
  const runsHolder: { current: { runId: string; status: string }[] } = { current: [] };
  const mockSend = vi.fn(async () => ({ runId: 'run-1' }));
  const mockWakeAgent = vi.fn(async () => ({ runId: 'run-1', invocationId: 'inv-1' }));
  const mockCancel = vi.fn(async () => {});
  const session = {
    cancel: mockCancel,
    view: { send: mockSend, runs: () => runsHolder.current, on: () => () => {} },
  };
  return { mockSend, mockWakeAgent, mockCancel, runsHolder, session };
});

let mockMessages: AI.UIMessage[] = [];

vi.mock('../../providers', () => ({
  SessionHooks: {
    useClientSession: () => ({ session }),
  },
}));

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useMessagesWithSeed: () => mockMessages,
}));

vi.mock('../../helpers', () => ({
  userMessage: (text: string) => ({ id: 'new-user', role: 'user', parts: [{ type: 'text', text }] }),
  wakeAgent: mockWakeAgent,
}));

import { SeededChat } from '../seeded-chat';

function userMsg(id: string, text: string): AI.UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
function assistantMsg(id: string, text: string): AI.UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

describe('<SeededChat> (use-client-session)', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockWakeAgent.mockClear();
    mockCancel.mockClear();
    runsHolder.current = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the composed conversation linearly', () => {
    mockMessages = [userMsg('u1', 'hi'), assistantMsg('a1', 'hello')];
    render(
      <SeededChat
        chatId="ai:test"
        seed={mockMessages}
        api="api/chat"
      />,
    );

    const items = screen.getAllByTestId('message');
    expect(items.map((el) => el.getAttribute('data-id'))).toEqual(['u1', 'a1']);
    expect(screen.getByText('hi')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('sends the typed message over the view and wakes the agent', async () => {
    mockMessages = [];
    render(
      <SeededChat
        chatId="ai:test"
        seed={[]}
        api="api/chat"
      />,
    );

    const input = screen.getByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'new turn' } });
    const form = input.closest('form');
    if (!form) throw new Error('expected the composer input to be inside a form');
    fireEvent.submit(form);

    expect(mockSend).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalledWith('api/chat', { runId: 'run-1' }));
  });

  it('marks the last assistant response with the latest run state and earlier ones completed', async () => {
    runsHolder.current = [{ runId: 'run-1', status: 'active' }];
    mockMessages = [
      userMsg('u1', 'hi'),
      assistantMsg('a1', 'first'),
      userMsg('u2', 'again'),
      assistantMsg('a2', 'second'),
    ];
    render(
      <SeededChat
        chatId="ai:test"
        seed={mockMessages}
        api="api/chat"
      />,
    );

    await waitFor(() => {
      const states = screen.getAllByTestId('message').map((el) => el.getAttribute('data-state'));
      expect(states).toEqual([null, 'completed', null, 'streaming']);
    });
  });

  it('shows Stop while a run is active and cancels it on click', async () => {
    runsHolder.current = [{ runId: 'run-active', status: 'active' }];
    mockMessages = [userMsg('u1', 'hi')];
    render(
      <SeededChat
        chatId="ai:test"
        seed={mockMessages}
        api="api/chat"
      />,
    );

    const stopButton = await screen.findByTestId('stop');
    fireEvent.click(stopButton);
    expect(mockCancel).toHaveBeenCalledWith('run-active');
  });

  it('cancels the active run before sending a concurrent message', async () => {
    runsHolder.current = [{ runId: 'run-active', status: 'active' }];
    mockMessages = [userMsg('u1', 'hi')];
    render(
      <SeededChat
        chatId="ai:test"
        seed={mockMessages}
        api="api/chat"
      />,
    );

    const input = screen.getByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'concurrent' } });
    const form = input.closest('form');
    if (!form) throw new Error('expected the composer input to be inside a form');
    fireEvent.submit(form);

    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('run-active'));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
  });
});
