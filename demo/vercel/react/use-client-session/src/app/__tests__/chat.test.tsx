import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import type * as AI from 'ai';
import { Invocation } from '@ably/ai-transport';
import type { BranchHandle, ClientRun, ClientSession, RunInfo, SendOptions } from '@ably/ai-transport';
import type { VercelInput, VercelOutput, VercelProjection } from '@ably/ai-transport/vercel';

// jsdom doesn't implement Element.prototype.scrollIntoView; MessageList's
// auto-scroll effect calls it whenever the message list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface
//
// `../providers` is mocked so the demo's React glue can be exercised without
// bringing up an Ably client, the codec, or the session. A breaking change to
// the SDK's session-hooks surface is caught at module-load or render-time.
// ---------------------------------------------------------------------------

let setMockViewMessages: ((messages: AI.UIMessage[]) => void) | null = null;

// Lets a test stub the View's runOf so the demo derives a Run status (and thus
// the Stop / Send button state) for the rendered messages. Default: no Run.
let mockRunOf: (codecMessageId: string) => RunInfo | undefined = () => undefined;

const mockSend = vi.fn(
  (_input: VercelInput | VercelInput[], _opts?: SendOptions): Promise<ClientRun<AI.UIMessage>> =>
    Promise.resolve({
      // The triggering input's codec-message-id — the synchronous routing
      // handle the client owns the moment it publishes.
      inputCodecMessageId: 'input-1',
      // The agent mints the run-id now, so `runId` is empty until `started`
      // resolves (once `ai-run-start` is observed). A fresh send omits run-id
      // from the invocation pointer, leaving the agent to mint it.
      runId: '',
      status: 'active',
      error: undefined,
      messages: [],
      started: Promise.resolve(),
      inputEventId: 'ev-1',
      cancel: async () => {},
      toInvocation: () => Invocation.fromJSON({ inputEventId: 'ev-1', sessionName: 'demo' }),
    }),
);

const mockSession = {
  tree: { on: vi.fn(() => () => {}) },
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  on: vi.fn(() => () => {}),
} as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

const emptyBranchHandle = (): BranchHandle<AI.UIMessage> => ({
  hasSiblings: false,
  siblings: [],
  index: 0,
  selected: undefined,
  select: () => {},
});

vi.mock('../providers', () => ({
  SessionHooks: {
    ClientSessionProvider: ({ children }: { children: ReactNode }) => children,
    useClientSession: () => ({ session: mockSession, sessionError: undefined }),
    useAblyMessages: () => [],
    useView: () => {
      const [messages, setMessages] = useState<AI.UIMessage[]>([]);
      useEffect(() => {
        setMockViewMessages = setMessages;
        return () => {
          setMockViewMessages = null;
        };
      }, []);
      return {
        // The demo renders and correlates off the codec-message-id pairs; the
        // mock derives them from the domain id (here they coincide).
        messages: messages.map((message) => ({ codecMessageId: message.id, message })),
        hasOlder: false,
        loading: false,
        loadOlder: async () => {},
        branchSelection: emptyBranchHandle,
        runOf: (codecMessageId: string) => mockRunOf(codecMessageId),
        run: () => undefined,
        send: mockSend,
        regenerate: vi.fn(),
        edit: vi.fn(),
        on: () => () => {},
      };
    },
  },
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

// Chat must be imported AFTER vi.mock so it picks up the mocked module.
// eslint-disable-next-line import/first
import { Chat } from '../components/chat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const assistantText = (text: string): AI.UIMessage => ({
  id: 'msg-assistant-1',
  role: 'assistant',
  parts: [{ type: 'text', text, state: 'done' }],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<Chat>', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockRunOf = () => undefined;
    vi.mocked(mockSession.cancel).mockClear();
    // The demo wakes the agent by POSTing the invocation after each send.
    // Stub fetch so that POST succeeds rather than hitting the network; the
    // agent route returns the minted invocation-id, which wakeAgent reads.
    vi.stubGlobal(
      'fetch',
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      vi.fn(() => Promise.resolve(Response.json({ invocationId: 'inv-1' }))),
    );
  });

  afterEach(() => {
    // vitest isn't configured with globals, so @testing-library/react's
    // auto-cleanup hook isn't registered — unmount explicitly so each test
    // starts from an empty DOM (otherwise a second render duplicates the
    // input bar and role queries find multiple matches).
    cleanup();
    vi.unstubAllGlobals();
  });

  it('mounts, sends the user input via view.send, and renders messages pushed through the view', async () => {
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
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
    const sent = mockSend.mock.calls[0][0];
    const sentInputs = Array.isArray(sent) ? sent : [sent];
    const sentText = sentInputs.flatMap((i) =>
      i.kind === 'user-message'
        ? i.message.parts.filter((p): p is AI.TextUIPart => p.type === 'text').map((p) => p.text)
        : [],
    );
    expect(sentText).toContain('hello');

    expect(setMockViewMessages).not.toBeNull();
    act(() => {
      setMockViewMessages?.([assistantText('Hi there')]);
    });

    expect(screen.queryByText('Hi there')).not.toBeNull();
  });

  it('shows Send (not Stop) when the latest run is suspended awaiting approval', async () => {
    // A run paused in the approval-requested state has no live stream to abort
    // (the serverless agent terminated on suspend), so there is nothing for
    // Stop to act on: the input bar shows Send and the user proceeds via the
    // approval card. This mirrors the useChat demo, where Stop shows only while
    // the request is in flight (status 'submitted' | 'streaming'). Showing Stop
    // here was the bug - pressing it published a dead ai-cancel that no agent
    // acted on, leaving the run suspended on a refresh.
    mockRunOf = () => ({
      runId: 'run-suspended-1',
      clientId: 'user-a',
      status: 'suspended',
      invocationId: 'inv-1',
      steps: [],
    });

    render(
      <Chat
        chatId="ai:test"
        api="api/chat"
      />,
    );

    act(() => {
      setMockViewMessages?.([assistantText('Calling getWeatherForecast...')]);
    });

    // Scope the button assertions to the input bar's <form> so descriptive
    // copy / suggestion chips elsewhere on the page (which also mention "Stop"
    // and "Send") can't satisfy the role query.
    const inputForm = screen.getByPlaceholderText('Type a message...').closest('form');
    if (!inputForm) throw new Error('input is not nested in a <form>');
    const inputBar = within(inputForm);

    // Suspended run -> Send is offered, Stop is not.
    expect(await inputBar.findByRole('button', { name: /Send/i })).not.toBeNull();
    expect(inputBar.queryByRole('button', { name: /Stop/i })).toBeNull();
  });

  it('shows Stop while the latest run is actively streaming, and Stop publishes a cancel for it', async () => {
    // An 'active' run is genuinely in flight, so Stop is offered; pressing it
    // publishes session.cancel for that run (a live agent then aborts and ends
    // the run, flipping it terminal and reverting Stop to Send).
    mockRunOf = () => ({
      runId: 'run-active-1',
      clientId: 'user-a',
      status: 'active',
      invocationId: 'inv-1',
      steps: [],
    });

    render(
      <Chat
        chatId="ai:test"
        api="api/chat"
      />,
    );

    act(() => {
      setMockViewMessages?.([assistantText('streaming a reply...')]);
    });

    const inputForm = screen.getByPlaceholderText('Type a message...').closest('form');
    if (!inputForm) throw new Error('input is not nested in a <form>');
    const inputBar = within(inputForm);

    // Active run -> Stop is offered, Send is not.
    const stop = await inputBar.findByRole('button', { name: /Stop/i });
    expect(inputBar.queryByRole('button', { name: /Send/i })).toBeNull();

    fireEvent.click(stop);
    await waitFor(() => {
      expect(mockSession.cancel).toHaveBeenCalledWith('run-active-1');
    });
  });
});
