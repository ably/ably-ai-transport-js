import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import * as Ably from 'ably';
import type { PublishInputResult, TransportEvent, WireMeta } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';
import type { OpenAIInput } from '../lib/openai-thread';
import type { Responses } from 'openai/resources/responses/responses';
import { Chat } from '../components/chat';

// jsdom doesn't implement Element.prototype.scrollIntoView; MessageList's
// auto-scroll effect calls it whenever the message list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface
//
// `@ably/ai-transport/react` is mocked so the demo's React glue — including
// the real merge in useResponsesThread — can be exercised without bringing up
// an Ably client. Tests drive the UI by emitting decoded transport events
// through the captured useTransportEvents handlers, exactly what the real
// hook would deliver.
//
// Shared mutable state lives in vi.hoisted so it is initialised before the
// hoisted vi.mock factory runs, which lets every import stay at the top.
// ---------------------------------------------------------------------------

type Event = TransportEvent<OpenAIInput, OpenAIOutput>;

const mockState = vi.hoisted(() => {
  const state = {
    handlers: new Set<(event: unknown) => void>(),
    publishInput: vi.fn<(...args: unknown[]) => unknown>(),
    cancel: vi.fn<(runId: string) => Promise<void>>(async () => {}),
    historyBatches: [] as { events: unknown[]; exhausted: boolean }[],
    // A single stable transport object: the real provider memoises it, and the
    // thread hook keys its hydration effect on its identity.
    transport: {
      connect: async () => {},
      history: async () => state.historyBatches.shift() ?? { events: [], exhausted: true },
      publishInput: (...args: unknown[]) => state.publishInput(...args) as unknown,
      cancel: (runId: string) => state.cancel(runId) as unknown,
      subscribe: () => () => {},
      on: () => () => {},
      close: () => {},
    },
  };
  return state;
});

vi.mock('@ably/ai-transport/react', () => ({
  useClientTransport: () => ({ transport: mockState.transport, error: undefined }),
  useTransportEvents: (handler: (event: unknown) => void) => {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    useEffect(() => {
      const stable = (event: unknown) => {
        handlerRef.current(event);
      };
      mockState.handlers.add(stable);
      return () => {
        mockState.handlers.delete(stable);
      };
    }, []);
  },
  useAblyMessages: () => [],
}));

// The header's AvatarStack enters presence and reads the member set via
// ably-js's React presence hooks. Stub them so the Chat render needs no Ably
// client; an empty member set renders no avatars, which the chat tests ignore.
vi.mock('ably/react', () => ({
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

// ---------------------------------------------------------------------------
// Fixtures — decoded transport events, in the shapes the SDK's decoder emits.
// ---------------------------------------------------------------------------

const makeMeta = (overrides: Partial<WireMeta>): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: 's-1',
  transportMessageId: undefined,
  runId: undefined,
  stepId: undefined,
  stepStartSerial: undefined,
  timestamp: 1,
  role: undefined,
  clientId: undefined,
  messageName: undefined,
  versionSerial: undefined,
  versionTimestamp: undefined,
  inputTransportMessageId: undefined,
  inputTransportMessageIds: undefined,
  steerTransportMessageIds: undefined,
  ...overrides,
});

const userMessageEvent = (transportMessageId: string, text: string): Event => ({
  kind: 'message',
  meta: makeMeta({ transportMessageId, role: 'user', clientId: 'user-a' }),
  inputs: [
    {
      kind: 'message',
      payload: { role: 'user', items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] },
    },
  ],
  outputs: [],
});

const messageItem = (id: string, text: string): Responses.ResponseOutputMessage => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

const assistantTurnEvent = (transportMessageId: string, runId: string, text: string): Event => ({
  kind: 'message',
  meta: makeMeta({ transportMessageId, role: 'assistant', runId }),
  inputs: [],
  // CAST: mirrors the decoded item envelope, which carries no sequence_number.
  outputs: [
    {
      type: 'response.output_item.added',
      item: messageItem(`i-${transportMessageId}`, text),
      output_index: 0,
    } as OpenAIOutput,
  ],
});

const runStart = (runId: string, inputTransportMessageId?: string): Event => ({
  kind: 'run-lifecycle',
  event: {
    type: 'start',
    runId,
    clientId: 'agent',
    invocationId: 'inv-1',
    serial: 's-run',
    ...(inputTransportMessageId !== undefined && { inputTransportMessageId }),
  },
});

const runSuspend = (runId: string): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'suspend', runId, clientId: 'agent', invocationId: 'inv-1', serial: 's-run' },
});

const runEndError = (runId: string, message: string): Event => ({
  kind: 'run-lifecycle',
  event: {
    type: 'end',
    runId,
    clientId: 'agent',
    invocationId: 'inv-1',
    serial: 's-run',
    reason: 'error',
    error: new Ably.ErrorInfo(message, 104008, 500),
  },
});

const emit = (...events: Event[]) => {
  act(() => {
    for (const event of events) {
      for (const handler of [...mockState.handlers]) handler(event);
    }
  });
};

const renderChat = async () => {
  const view = render(
    <Chat
      chatId="ai:test"
      clientId="user-a"
      api="api/chat"
    />,
  );
  // Wait for hydration (connect + history paging) to finish so emitted events
  // apply directly instead of sitting in the buffer.
  await waitFor(() => {
    expect(screen.queryByText('Loading history…')).toBeNull();
  });
  return view;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<Chat>', () => {
  beforeEach(() => {
    mockState.handlers.clear();
    mockState.historyBatches = [];
    mockState.publishInput.mockReset();
    mockState.publishInput.mockImplementation(
      async (): Promise<PublishInputResult> => ({
        transportMessageId: 'cm-user-1',
        eventId: 'ev-1',
        runId: Promise.resolve('run-1'),
      }),
    );
    mockState.cancel.mockClear();
    // Two fetch surfaces: the hydration GET to the messages endpoint (answered
    // with an empty seed, so the gap walk pages mockState.historyBatches), and
    // the wake POST to the chat route (answered with the run-id wakeAgent
    // reads).
    vi.stubGlobal(
      'fetch',
      vi.fn((url: RequestInfo | URL) =>
        String(url).includes('/api/messages')
          ? Promise.resolve(Response.json({ events: [], latestSerial: undefined }))
          : Promise.resolve(Response.json({ runId: 'run-1' })),
      ),
    );
  });

  afterEach(() => {
    // vitest isn't configured with globals, so @testing-library/react's
    // auto-cleanup hook isn't registered — unmount explicitly so each test
    // starts from an empty DOM.
    cleanup();
    vi.unstubAllGlobals();
  });

  it('publishes the user input, wakes the agent with its eventId, and renders emitted turns', async () => {
    await renderChat();

    const input = screen.getByPlaceholderText('Type a message...');
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockState.publishInput).toHaveBeenCalledTimes(1);
    });
    expect(mockState.publishInput).toHaveBeenCalledWith({
      kind: 'message',
      payload: {
        role: 'user',
        items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
    });

    // The wake POST carries the channel and the published input's eventId
    // (the hydration GET to the messages endpoint fires separately on mount).
    const fetchMock = vi.mocked(fetch);
    const wakeCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([target]) => String(target) === 'api/chat');
      if (!call) throw new Error('wake POST not observed yet');
      return call;
    });
    const [url, init] = wakeCall;
    expect(url).toBe('api/chat');
    expect(JSON.parse(String(init?.body))).toEqual({ channelName: 'ai:test', eventId: 'ev-1' });

    emit(assistantTurnEvent('cm-a1', 'run-1', 'Hi there'));
    expect(screen.queryByText('Hi there')).not.toBeNull();
  });

  it('hydrates the thread from history batches before live events', async () => {
    mockState.historyBatches = [
      // First call returns the most recent slice; the next call the older one.
      {
        events: [runStart('run-1', 'cm-u1'), assistantTurnEvent('cm-a1', 'run-1', 'restored reply')],
        exhausted: false,
      },
      { events: [userMessageEvent('cm-u1', 'restored prompt')], exhausted: true },
    ];
    await renderChat();
    expect(screen.queryByText('restored prompt')).not.toBeNull();
    expect(screen.queryByText('restored reply')).not.toBeNull();
  });

  it('hydrates from the messages endpoint seed and walks only the gap newer than its seam', async () => {
    const withSerial = (event: Event, serial: string): Event =>
      event.kind === 'message' ? { ...event, meta: { ...event.meta, serial } } : event;
    // The endpoint's read covered the stored prompt (seam s-2); the gap walk
    // must merge only the newer assistant turn, even though the first history
    // batch replays the stored prompt too, and must stop at the seam without
    // paging the older batch.
    const seedEvents = [withSerial(userMessageEvent('cm-u1', 'stored prompt'), 's-2')];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: RequestInfo | URL) =>
        String(url).includes('/api/messages')
          ? Promise.resolve(Response.json({ events: seedEvents, latestSerial: 's-2' }))
          : Promise.resolve(Response.json({ runId: 'run-1' })),
      ),
    );
    mockState.historyBatches = [
      {
        events: [
          withSerial(userMessageEvent('cm-u1', 'stored prompt'), 's-2'),
          withSerial(assistantTurnEvent('cm-a1', 'run-1', 'newer reply'), 's-3'),
        ],
        exhausted: false,
      },
      { events: [withSerial(userMessageEvent('cm-u0', 'beyond the seam'), 's-1')], exhausted: true },
    ];

    await renderChat();

    expect(screen.getAllByText('stored prompt')).toHaveLength(1);
    expect(screen.queryByText('newer reply')).not.toBeNull();
    // The walk stopped at the seam: the older batch was never paged.
    expect(screen.queryByText('beyond the seam')).toBeNull();
    expect(mockState.historyBatches).toHaveLength(1);
  });

  it('shows Send (not Stop) when the latest run is suspended', async () => {
    await renderChat();
    emit(runStart('run-s1'), assistantTurnEvent('cm-a1', 'run-s1', 'paused...'), runSuspend('run-s1'));

    const inputForm = screen.getByPlaceholderText('Type a message...').closest('form');
    if (!inputForm) throw new Error('input is not nested in a <form>');
    const inputBar = within(inputForm);

    expect(await inputBar.findByRole('button', { name: /Send/i })).not.toBeNull();
    expect(inputBar.queryByRole('button', { name: /Stop/i })).toBeNull();
  });

  it('renders the run error under the user message when the run failed before producing output', async () => {
    await renderChat();
    // A pre-output failure: the run errored with no assistant turn, so the
    // only visible message is the user's own. Its bubble carries the error.
    emit(
      userMessageEvent('cm-u1', 'hello'),
      runStart('run-err-1', 'cm-u1'),
      runEndError('run-err-1', 'agent reported an error'),
    );

    const errors = screen.getAllByText('agent reported an error');
    expect(errors).toHaveLength(1);
    // Rendered on the user's (end-aligned) side of the conversation.
    expect(errors[0].closest('[data-align="end"]')).not.toBeNull();
  });

  it('renders a mid-output run error on the assistant bubble only, not the triggering user message', async () => {
    await renderChat();
    emit(
      userMessageEvent('cm-u1', 'hello'),
      runStart('run-err-2', 'cm-u1'),
      assistantTurnEvent('cm-a1', 'run-err-2', 'partial reply'),
      runEndError('run-err-2', 'agent reported an error'),
    );

    const errors = screen.getAllByText('agent reported an error');
    expect(errors).toHaveLength(1);
    // Rendered on the assistant's (start-aligned) side of the conversation.
    expect(errors[0].closest('[data-align="start"]')).not.toBeNull();
  });

  it('shows Stop while the latest run is actively streaming, and Stop publishes a cancel for it', async () => {
    await renderChat();
    emit(runStart('run-active-1'), assistantTurnEvent('cm-a1', 'run-active-1', 'streaming a reply...'));

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
