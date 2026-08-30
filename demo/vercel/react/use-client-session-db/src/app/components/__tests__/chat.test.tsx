import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type * as AI from 'ai';
import type { CodecMessage, RunInfo, SendOptions } from '@ably/ai-transport';
import type { VercelSessionInput } from '@ably/ai-transport/vercel';

// jsdom doesn't implement Element.prototype.scrollIntoView; MessageList's
// auto-scroll effect calls it whenever the message list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface — Chat is glue over the session view, the SDK's
// useMessagesWithSeed seam walk, and the client-tool driver. The mocks let us
// exercise the linear render, the send → wakeAgent path, the run-state / Stop
// UI, and the tool approval flow without an Ably client or the codec.
//
// `session` is a single stable object — the real provider memoizes it, and the
// chat's run-state / tool effects depend on `session.view`, so a fresh object
// per render would re-run them forever. `viewMessages` / `runsHolder` are the
// mutable state each test sets before rendering.
// ---------------------------------------------------------------------------

const { mockSend, mockSteer, mockCancel, mockWakeAgent, runsHolder, viewMessagesHolder, session } = vi.hoisted(() => {
  const runsHolder: { current: RunInfo[] } = { current: [] };
  const viewMessagesHolder: { current: CodecMessage<AI.UIMessage>[] } = { current: [] };
  // Typed via vi.fn's generic (not impl params) so `mock.calls` is typed for the
  // approval-args assertions without declaring unused parameters.
  // The returned run carries a resolved `started` promise (the chat registers
  // the handle for /steer once run-start lands) and a `steer` stub the steer
  // path calls. `steer` returns the SDK's { published, outcome } pair.
  const mockSteer = vi.fn(() => ({
    published: Promise.resolve({ serial: 'steer-serial' }),
    outcome: Promise.resolve({ consumed: true }),
  }));
  const mockSend = vi.fn<
    (
      events: VercelSessionInput | VercelSessionInput[],
      opts?: SendOptions,
    ) => Promise<{ runId: string; started: Promise<void>; steer: typeof mockSteer }>
  >(async () => ({ runId: 'run-1', started: Promise.resolve(), steer: mockSteer }));
  const mockCancel = vi.fn(async () => {});
  const mockWakeAgent = vi.fn(async () => ({ runId: 'run-1', invocationId: 'inv-1' }));
  const session = {
    tree: { on: vi.fn(() => () => {}) },
    on: vi.fn(() => () => {}),
    cancel: mockCancel,
    view: {
      send: mockSend,
      getMessages: () => viewMessagesHolder.current,
      runs: () => runsHolder.current,
      runOf: (codecMessageId: string) =>
        runsHolder.current.find(() =>
          viewMessagesHolder.current.some((m) => m.codecMessageId === codecMessageId && m.message.role === 'assistant'),
        ) ?? runsHolder.current.at(-1),
      // The shared useDemoProgress calls branchSelection(id).hasSiblings; this
      // linear demo never branches, so every message reports no siblings.
      branchSelection: () => ({ hasSiblings: false }),
      on: () => () => {},
    },
  };
  return { mockSend, mockSteer, mockCancel, mockWakeAgent, runsHolder, viewMessagesHolder, session };
});

// The linear rendered list, driven per test.
let renderedMessages: AI.UIMessage[] = [];

// Stub the shared package's session/helper seams while rendering its real UI
// (ChatShell, LinearMessageList, DebugPane): override only the Ably-touching
// pieces and keep every real component so the render assertions exercise the
// shared shadcn UI.
vi.mock('@ably-ai-demos/frontend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ably-ai-demos/frontend')>();
  return {
    ...actual,
    SessionHooks: {
      useClientSession: () => ({ session }),
      useAblyMessages: () => [],
      // Chat reads the tree's getRunNode to seed a client-tool fork; the
      // useClientTools driver that consumes it is mocked to a no-op below, so a
      // stub returning no node suffices here.
      useTree: () => ({ getRunNode: () => undefined }),
    },
    userMessage: (text: string) => ({ id: 'new-user', role: 'user', parts: [{ type: 'text', text }] }),
    wakeAgent: mockWakeAgent,
  };
});

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useMessagesWithSeed: () => renderedMessages,
}));

// The header's AvatarStack enters presence and reads the member set via
// ably-js's React presence hooks. Stub them so the Chat render needs no Ably
// client; an empty member set renders no avatars.
vi.mock('ably/react', () => ({
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

// The client-tool driver runs its own view scan; stub it out so the Chat tests
// isolate the render + send + approval glue. (It has its own unit coverage
// only indirectly via e2e; here it must not interfere with the render.)
vi.mock('../../hooks/use-client-tools', () => ({
  useClientTools: () => {},
}));

// Chat must be imported AFTER vi.mock so it picks up the mocked modules.
import { Chat } from '../chat';

function userMsg(id: string, text: string): AI.UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
function assistantText(id: string, text: string): AI.UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text, state: 'done' }] };
}
function assistantApproval(id: string, toolCallId: string): AI.UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'getWeatherForecast',
        toolCallId,
        state: 'approval-requested',
        input: { location: 'London, UK' },
      } as AI.DynamicToolUIPart,
    ],
  };
}

describe('<Chat> (use-client-session-db)', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockSteer.mockClear();
    mockCancel.mockClear();
    mockWakeAgent.mockClear();
    runsHolder.current = [];
    viewMessagesHolder.current = [];
    renderedMessages = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ runId: 'run-1', invocationId: 'inv-1' })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const renderChat = () =>
    render(
      <Chat
        chatId="ai:test"
        clientId="user-a"
        seed={renderedMessages}
        api="api/chat"
      />,
    );

  it('renders the composed conversation linearly (no branch nav)', () => {
    renderedMessages = [userMsg('u1', 'hi'), assistantText('a1', 'hello')];
    renderChat();

    expect(screen.getByText('hi')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
    // No branch navigator arrows and no edit/regenerate affordances.
    expect(screen.queryByTitle('Previous branch')).toBeNull();
    expect(screen.queryByTitle('Next branch')).toBeNull();
    expect(screen.queryByTitle('Edit message')).toBeNull();
    expect(screen.queryByTitle('Regenerate response')).toBeNull();
  });

  it('sends the typed message over the view and wakes the agent', async () => {
    renderChat();

    const input = screen.getByPlaceholderText(/^Type a message/);
    fireEvent.change(input, { target: { value: 'new turn' } });
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');
    fireEvent.submit(form);

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mockWakeAgent).toHaveBeenCalledWith('api/chat', expect.objectContaining({ runId: 'run-1' })),
    );
  });

  it('shows Stop while the latest run is active, and Stop cancels it', async () => {
    runsHolder.current = [
      { runId: 'run-active', clientId: 'user-a', status: 'active', invocationId: 'inv-1', steps: [] },
    ];
    renderedMessages = [userMsg('u1', 'hi')];
    renderChat();

    const inputForm = screen.getByPlaceholderText(/^Type a message/).closest('form');
    if (!inputForm) throw new Error('input is not nested in a <form>');
    const inputBar = within(inputForm);

    const stop = await inputBar.findByRole('button', { name: /Stop/i });
    expect(inputBar.queryByRole('button', { name: /Send/i })).toBeNull();
    fireEvent.click(stop);
    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('run-active'));
  });

  it('shows Send (not Stop) when the latest run is suspended awaiting approval', async () => {
    runsHolder.current = [
      { runId: 'run-suspended', clientId: 'user-a', status: 'suspended', invocationId: 'inv-1', steps: [] },
    ];
    renderedMessages = [assistantApproval('a1', 'call-1')];
    renderChat();

    const inputForm = screen.getByPlaceholderText(/^Type a message/).closest('form');
    if (!inputForm) throw new Error('input is not nested in a <form>');
    const inputBar = within(inputForm);

    expect(await inputBar.findByRole('button', { name: /Send/i })).toBeTruthy();
    expect(inputBar.queryByRole('button', { name: /Stop/i })).toBeNull();
  });

  it('cancels the active run before sending a concurrent message', async () => {
    runsHolder.current = [
      { runId: 'run-active', clientId: 'user-a', status: 'active', invocationId: 'inv-1', steps: [] },
    ];
    renderedMessages = [userMsg('u1', 'hi')];
    renderChat();

    // Active run shows Stop, so the composer's Send isn't available — but the
    // form still submits on Enter, cancelling the active run first.
    const input = screen.getByPlaceholderText(/^Type a message/);
    fireEvent.change(input, { target: { value: 'concurrent' } });
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');
    fireEvent.submit(form);

    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('run-active'));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
  });

  it('approving a pending tool call looks up its codec-message-id and publishes an approval response', async () => {
    runsHolder.current = [
      { runId: 'run-approval', clientId: 'user-a', status: 'suspended', invocationId: 'inv-1', steps: [] },
    ];
    // The rendered list carries the approval bubble; view.getMessages() carries
    // the same message paired with its codec-message-id.
    renderedMessages = [assistantApproval('a1', 'call-1')];
    viewMessagesHolder.current = [{ codecMessageId: 'codec-a1', message: assistantApproval('a1', 'call-1') }];
    renderChat();

    const approve = await screen.findByRole('button', { name: /Approve/i });
    fireEvent.click(approve);

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    const [events, opts] = mockSend.mock.calls[0];
    // The approval response is addressed at the looked-up codec-message-id, on
    // the owning run.
    expect(opts).toEqual({ runId: 'run-approval' });
    expect(Array.isArray(events)).toBe(true);
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalled());
  });

  it('folds a /steer into the active run without cancelling it or sending a new turn', async () => {
    renderChat();

    // First send a normal turn so the run handle is registered for /steer
    // (registration happens once the returned run's `started` resolves).
    const input = screen.getByPlaceholderText(/^Type a message/);
    fireEvent.change(input, { target: { value: 'first turn' } });
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');
    fireEvent.submit(form);
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalled());

    // That run is now active on the channel.
    runsHolder.current = [{ runId: 'run-1', clientId: 'user-a', status: 'active', invocationId: 'inv-1', steps: [] }];
    mockSend.mockClear();
    mockCancel.mockClear();

    // A /steer folds into the active run: it calls the handle's steer(), and —
    // unlike a plain concurrent send — does NOT cancel the run or start a new one.
    fireEvent.change(input, { target: { value: '/steer keep going' } });
    fireEvent.submit(form);

    await waitFor(() => expect(mockSteer).toHaveBeenCalledTimes(1));
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a /steer when there is no active run to target', async () => {
    renderChat();

    const input = screen.getByPlaceholderText(/^Type a message/);
    fireEvent.change(input, { target: { value: '/steer too early' } });
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');
    fireEvent.submit(form);

    // Awaiting the composer clearing flushes the (would-be) async send path, so
    // the not-called assertions below are not racing an unsettled microtask.
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    // No active run: the steer path bails before publishing. The plain send /
    // cancel paths (which a non-/steer message would take) are never reached.
    expect(mockSteer).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });
});
