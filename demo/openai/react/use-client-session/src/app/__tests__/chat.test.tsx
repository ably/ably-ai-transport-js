import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import * as Ably from 'ably';
import { ErrorCode, Invocation } from '@ably/ai-transport';
import type { BranchHandle, ClientRun, RunInfo, SendOptions } from '@ably/ai-transport';
import type { OpenAIInput, OpenAIMessage } from '@ably/ai-transport/openai';
import { turnText, userTurn } from '../helpers';
import { Chat } from '../components/chat';

// jsdom doesn't implement Element.prototype.scrollIntoView; MessageList's
// auto-scroll effect calls it whenever the message list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface
//
// `../providers` is mocked so the demo's React glue can be exercised without
// bringing up an Ably client, the codec, or the session. A breaking change to
// the SDK's session-hooks surface is caught at module-load or render-time.
//
// Shared mutable state lives in vi.hoisted so it is initialised before the
// hoisted vi.mock factory runs, which lets every import stay at the top.
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  // The mock view's React setState, captured on mount so tests can push turns.
  setMessages: null as null | ((messages: OpenAIMessage[]) => void),
  // Test-overridable: lets a test stub the Run owning the rendered messages so
  // the demo derives a status (and thus the Stop / Send button state).
  runOf: (() => undefined) as (codecMessageId: string) => RunInfo | undefined,
  cancel: vi.fn(async () => {}),
  send: vi.fn<
    (input: OpenAIInput | OpenAIInput[], opts?: SendOptions) => Promise<ClientRun<OpenAIInput, OpenAIMessage>>
  >(),
}));

vi.mock('../providers', () => ({
  SessionHooks: {
    ClientSessionProvider: ({ children }: { children: ReactNode }) => children,
    useClientSession: () => ({
      session: {
        tree: { on: () => () => {} },
        cancel: mockState.cancel,
        close: async () => {},
        on: () => () => {},
      },
      sessionError: undefined,
    }),
    useAblyMessages: () => [],
    useView: () => {
      const [messages, setMessages] = useState<OpenAIMessage[]>([]);
      useEffect(() => {
        mockState.setMessages = setMessages;
        return () => {
          mockState.setMessages = null;
        };
      }, []);
      const emptyBranch = (): BranchHandle<OpenAIMessage> => ({
        hasSiblings: false,
        siblings: [],
        index: 0,
        selected: undefined,
        select: () => {},
      });
      return {
        // The demo renders and correlates off the codec-message-id pairs.
        messages: messages.map((message, i) => ({ codecMessageId: `cm-${i}`, message })),
        hasOlder: false,
        loading: false,
        loadOlder: async () => {},
        branchSelection: emptyBranch,
        runOf: (codecMessageId: string) => mockState.runOf(codecMessageId),
        run: () => undefined,
        send: mockState.send,
        regenerate: vi.fn(),
        edit: vi.fn(),
      };
    },
  },
}));

vi.mock('@ably-ai-demos/frontend/ably-provider', () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
  useAblyReady: () => true,
}));

// The header's AvatarStack enters presence and reads the member set via
// ably-js's React presence hooks. Stub them so the Chat render needs no Ably
// client; an empty member set renders no avatars, which the chat tests ignore.
vi.mock('ably/react', () => ({
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fields common to every RunInfo stub; each test names only what it asserts on.
const runInfoBase = { clientId: 'user-a', invocationId: 'inv-1', steps: [] };

// A run that ended in error, as the View reports it for both the run's own
// output messages and (via input→reply-run resolution) the triggering user
// message. The error's values mirror the transport's generic run-end fallback
// (`buildRunEndError`) for a run that errored without stamped detail.
const erroredRun = (runId: string): RunInfo => ({
  ...runInfoBase,
  runId,
  status: 'error',
  error: new Ably.ErrorInfo('agent reported an error', ErrorCode.SessionSubscriptionError, 500),
});

const assistantTurn = (text: string): OpenAIMessage => ({
  role: 'assistant',
  items: [
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
});

const clientRunStub = (): ClientRun<OpenAIInput, OpenAIMessage> => ({
  inputCodecMessageId: 'input-1',
  // The agent mints the run-id, so `runId` is empty until `started` resolves.
  runId: '',
  status: 'active',
  error: undefined,
  messages: [],
  started: Promise.resolve(),
  inputEventId: 'ev-1',
  cancel: async () => {},
  steer: () => ({ published: Promise.resolve({ serial: undefined }), outcome: Promise.resolve({ consumed: false }) }),
  toInvocation: () => Invocation.fromJSON({ inputEventId: 'ev-1', sessionName: 'demo' }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<Chat>', () => {
  beforeEach(() => {
    mockState.send.mockReset();
    mockState.send.mockImplementation(() => Promise.resolve(clientRunStub()));
    mockState.runOf = () => undefined;
    mockState.cancel.mockClear();
    // The demo wakes the agent by POSTing the invocation after each send. Stub
    // fetch so the POST succeeds rather than hitting the network; the agent
    // route returns the minted ids, which wakeAgent reads.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ runId: 'run-1', invocationId: 'inv-1' }))),
    );
  });

  afterEach(() => {
    // vitest isn't configured with globals, so @testing-library/react's
    // auto-cleanup hook isn't registered — unmount explicitly so each test
    // starts from an empty DOM.
    cleanup();
    vi.unstubAllGlobals();
  });

  it('mounts, sends the user input via view.send, and renders turns pushed through the view', async () => {
    render(
      <Chat
        chatId="ai:test"
        api="api/chat"
      />,
    );

    const input = screen.getByPlaceholderText('Type a message...');
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockState.send).toHaveBeenCalledTimes(1);
    });
    const sent = mockState.send.mock.calls[0][0];
    const sentInputs = Array.isArray(sent) ? sent : [sent];
    const sentText = sentInputs.map((i) => (i.kind === 'user-message' ? turnText(i.message) : '')).filter(Boolean);
    expect(sentText).toContain('hello');

    expect(mockState.setMessages).not.toBeNull();
    act(() => {
      mockState.setMessages?.([assistantTurn('Hi there')]);
    });

    expect(screen.queryByText('Hi there')).not.toBeNull();
  });

  it('shows Send (not Stop) when the latest run is suspended', async () => {
    mockState.runOf = () => ({ ...runInfoBase, runId: 'run-suspended-1', status: 'suspended' });

    render(
      <Chat
        chatId="ai:test"
        api="api/chat"
      />,
    );

    act(() => {
      mockState.setMessages?.([assistantTurn('paused...')]);
    });

    const inputForm = screen.getByPlaceholderText('Type a message...').closest('form');
    if (!inputForm) throw new Error('input is not nested in a <form>');
    const inputBar = within(inputForm);

    expect(await inputBar.findByRole('button', { name: /Send/i })).not.toBeNull();
    expect(inputBar.queryByRole('button', { name: /Stop/i })).toBeNull();
  });

  it('renders the run error under the user message when the run failed before producing output', () => {
    mockState.runOf = () => erroredRun('run-err-1');

    render(
      <Chat
        chatId="ai:test"
        api="api/chat"
      />,
    );

    // A pre-output failure: the run errored with no assistant turn, so the
    // only visible message is the user's own. Its bubble carries the error.
    act(() => {
      mockState.setMessages?.([userTurn('hello')]);
    });

    const errors = screen.getAllByText('agent reported an error');
    expect(errors).toHaveLength(1);
    // Rendered on the user's (end-aligned) side of the conversation.
    expect(errors[0].closest('[data-align="end"]')).not.toBeNull();
  });

  it('renders a mid-output run error on the assistant bubble only, not the triggering user message', () => {
    // Both messages resolve to the same errored run: the user message via
    // input→reply-run resolution, the assistant message as the run's output.
    mockState.runOf = () => erroredRun('run-err-2');

    render(
      <Chat
        chatId="ai:test"
        api="api/chat"
      />,
    );

    act(() => {
      mockState.setMessages?.([userTurn('hello'), assistantTurn('partial reply')]);
    });

    const errors = screen.getAllByText('agent reported an error');
    expect(errors).toHaveLength(1);
    // Rendered on the assistant's (start-aligned) side of the conversation.
    expect(errors[0].closest('[data-align="start"]')).not.toBeNull();
  });

  it("renders a pre-output run error on the user message even when another run's assistant output is visible", () => {
    // Two runs: the assistant message belongs to an earlier, successful run;
    // the newest user message's reply run errored before producing output.
    // Pins that error placement is keyed on the errored run's own output, not
    // on whether any assistant message happens to be visible.
    mockState.runOf = (codecMessageId) =>
      codecMessageId === 'cm-2' ? erroredRun('run-err-3') : { ...runInfoBase, runId: 'run-ok-1', status: 'complete' };

    render(
      <Chat
        chatId="ai:test"
        api="api/chat"
      />,
    );

    act(() => {
      mockState.setMessages?.([userTurn('first'), assistantTurn('earlier reply'), userTurn('second')]);
    });

    const errors = screen.getAllByText('agent reported an error');
    expect(errors).toHaveLength(1);
    // Rendered on the user's (end-aligned) side of the conversation.
    expect(errors[0].closest('[data-align="end"]')).not.toBeNull();
  });

  it('shows Stop while the latest run is actively streaming, and Stop publishes a cancel for it', async () => {
    mockState.runOf = () => ({ ...runInfoBase, runId: 'run-active-1', status: 'active' });

    render(
      <Chat
        chatId="ai:test"
        api="api/chat"
      />,
    );

    act(() => {
      mockState.setMessages?.([assistantTurn('streaming a reply...')]);
    });

    const inputForm = screen.getByPlaceholderText('Type a message...').closest('form');
    if (!inputForm) throw new Error('input is not nested in a <form>');
    const inputBar = within(inputForm);

    const stop = await inputBar.findByRole('button', { name: /Stop/i });
    expect(inputBar.queryByRole('button', { name: /Send/i })).toBeNull();

    fireEvent.click(stop);
    await waitFor(() => {
      expect(mockState.cancel).toHaveBeenCalledWith('run-active-1');
    });
  });
});
