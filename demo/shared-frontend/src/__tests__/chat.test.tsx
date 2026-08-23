import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import type * as AI from 'ai';

// jsdom doesn't implement Element.prototype.scrollIntoView; shim it so a test
// render never throws if a component reaches for it.
Element.prototype.scrollIntoView = () => {};

// The header's AvatarStack enters presence and reads the member set via
// ably-js's React presence hooks. Stub them so the Chat render needs no Ably
// client; an empty member set renders no avatars, which the chat tests ignore.
vi.mock('ably/react', () => ({
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

// Chat must be imported AFTER vi.mock so it picks up the mocked module.
import { Chat } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userText = (id: string, text: string): AI.UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

const assistantText = (id: string, text: string): AI.UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text, state: 'done' }],
});

type ChatOverrides = Partial<Parameters<typeof Chat>[0]>;

// Chat is presentational: render it with inert defaults and let each test
// override the props it exercises.
function renderChat(over: ChatOverrides = {}) {
  return render(
    <Chat
      chatId="ai:test"
      messages={[]}
      isRunning={false}
      onSend={() => {}}
      ablyMessages={[]}
      callbackLog={[]}
      clientToolLog={[]}
      onClearLogs={() => {}}
      {...over}
    />,
  );
}

// Scope button queries to the input bar's <form> so descriptive copy and
// suggestion chips elsewhere on the page (which also mention "Stop" and
// "Send") can't satisfy the role query.
function inputBar() {
  const input = screen.getByPlaceholderText(/Type a message/);
  const form = input.closest('form');
  if (!form) throw new Error('input is not nested in a <form>');
  return { input, form, scope: within(form) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<Chat>', () => {
  afterEach(() => {
    // vitest isn't configured with globals, so @testing-library/react's
    // auto-cleanup hook isn't registered — unmount explicitly so each test
    // starts from an empty DOM (otherwise a second render duplicates the
    // input bar and role queries find multiple matches).
    cleanup();
  });

  it('renders the messages it is given and fires onSend with the composed text', () => {
    const onSend = vi.fn();
    renderChat({ messages: [assistantText('a1', 'Hi there')], onSend });

    expect(screen.queryByText('Hi there')).not.toBeNull();

    const { input, form } = inputBar();
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('shows Send (not Stop) while no run is in flight', () => {
    renderChat({ messages: [assistantText('a1', 'done reply')] });

    const { scope } = inputBar();
    expect(scope.getByRole('button', { name: /Send/i })).not.toBeNull();
    expect(scope.queryByRole('button', { name: /Stop/i })).toBeNull();
  });

  it('shows Stop while running, and Stop fires onStop', () => {
    const onStop = vi.fn();
    renderChat({ messages: [assistantText('a1', 'streaming a reply...')], isRunning: true, onStop });

    const { scope } = inputBar();
    const stop = scope.getByRole('button', { name: /Stop/i });
    expect(scope.queryByRole('button', { name: /Send/i })).toBeNull();

    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('marks the last assistant message as streaming while running', () => {
    renderChat({
      messages: [userText('u1', 'question'), assistantText('a1', 'partial reply')],
      isRunning: true,
    });

    const rows = screen.getAllByTestId('message');
    expect(rows[rows.length - 1].getAttribute('data-state')).toBe('streaming');
  });

  it('fires the approval callbacks with the pending tool part', () => {
    const onToolApprove = vi.fn();
    const onToolDeny = vi.fn();
    // CAST: `ToolUIPart` is a discriminated union keyed on `state`; build the
    // approval-requested fixture the tool card reads (its `approval.id`
    // completes that arm) and assert the union type.
    const toolPart = {
      type: 'tool-getWeatherForecast',
      toolCallId: 'tc1',
      state: 'approval-requested',
      input: { location: 'London' },
      approval: { id: 'ap1' },
    } as AI.ToolUIPart;
    const approvalMsg: AI.UIMessage = { id: 'a1', role: 'assistant', parts: [toolPart] };

    renderChat({ messages: [approvalMsg], onToolApprove, onToolDeny });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onToolApprove).toHaveBeenCalledWith(toolPart);

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onToolDeny).toHaveBeenCalledWith(toolPart);
  });

  it('routes /steer input to onSteer when provided', () => {
    const onSend = vi.fn();
    const onSteer = vi.fn();
    renderChat({ onSend, onSteer });

    const { input, form } = inputBar();
    fireEvent.change(input, { target: { value: '/steer talk like a pirate' } });
    fireEvent.submit(form);

    expect(onSteer).toHaveBeenCalledWith('talk like a pirate');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('passes /steer input through onSend when onSteer is not wired', () => {
    const onSend = vi.fn();
    renderChat({ onSend });

    const { input, form } = inputBar();
    fireEvent.change(input, { target: { value: '/steer talk like a pirate' } });
    fireEvent.submit(form);

    expect(onSend).toHaveBeenCalledWith('/steer talk like a pirate');
  });

  it('threads hasOlder/onLoadOlder to the transcript', () => {
    const onLoadOlder = vi.fn();
    renderChat({ messages: [userText('u1', 'hi')], hasOlder: true, onLoadOlder });

    fireEvent.click(screen.getByTestId('load-older'));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});
