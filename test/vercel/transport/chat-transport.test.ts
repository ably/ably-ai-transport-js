/**
 * ChatTransport unit tests — the useChat adapter over the standalone
 * ClientTransport.
 *
 * The adapter holds no conversation state: it indexes the wire identity
 * (codec-message-id, run-id) every event already carries and the set of tool
 * calls whose resolution is on the wire, publishes bodies from the codec's
 * own union, and streams one run's output chunks per send. These tests drive
 * it against a fake ClientTransport, covering the fresh send, the
 * tool-continuation resume (publish-on-sendMessages-only, seeded so a reload
 * republishes nothing), regeneration, and the reconnect scan.
 */

import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import {
  type Event,
  FakeClientTransport,
  messageEvent,
  runEndEvent,
  runStartEvent,
  runSuspendEvent,
} from './helpers.js';

const userMessage = (id: string, text: string): AI.UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

/**
 * Stub global fetch to answer every call with the given JSON body.
 * @param body - The JSON body to answer with.
 * @param status - The HTTP status (defaults to 200).
 * @returns The fetch mock.
 */
const stubFetch = (body: unknown, status = 200): ReturnType<typeof vi.fn> => {
  // A fresh Response per call: a Response body is single-read, and a test may
  // drive more than one POST through the same stub.
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch's contract is a promise; the fake resolves immediately
  const mock = vi.fn().mockImplementation(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', mock);
  return mock;
};

/**
 * Read a chunk stream to completion.
 * @param stream - The stream to drain.
 * @returns The collected chunks.
 */
const readAll = async (stream: ReadableStream<AI.UIMessageChunk>): Promise<AI.UIMessageChunk[]> => {
  const chunks: AI.UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
};

/**
 * A connected-and-seeded adapter pair, like the hydration hook produces.
 * @param gapEvents - History events to seed the adapter's indices with.
 * @returns The fake transport and the adapter.
 */
const setup = (gapEvents: Event[] = []): { fake: FakeClientTransport; chat: ChatTransport } => {
  const fake = new FakeClientTransport();
  const chat = createChatTransport({ transport: fake, channelName: 'ai:test' });
  chat.seed(gapEvents);
  return { fake, chat };
};

const sendOptions = (
  messages: AI.UIMessage[],
  overrides: {
    trigger?: 'submit-message' | 'regenerate-message';
    messageId?: string;
    abortSignal?: AbortSignal;
  } = {},
): Parameters<ChatTransport['sendMessages']>[0] => ({
  trigger: overrides.trigger ?? 'submit-message',
  chatId: 'ai:test',
  messageId: overrides.messageId,
  messages,
  abortSignal: overrides.abortSignal,
});

/**
 * Gap events for an assistant that called a tool and suspended awaiting
 * approval.
 * @param runId - The run the assistant streamed under, or `undefined` for an
 *   event with no run-id header.
 * @returns The events, oldest-first.
 */
const approvalGapEvents = (runId?: string): Event[] => [
  messageEvent(
    { codecMessageId: 'wire-u1', role: 'user' },
    { inputs: [{ kind: 'message', payload: userMessage('u1', 'forecast please') }] },
  ),
  messageEvent(
    { codecMessageId: 'wire-a1', runId, role: 'assistant' },
    {
      outputs: [
        { type: 'start', messageId: 'a1' },
        { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'getWeatherForecast' },
        {
          type: 'tool-input-available',
          toolCallId: 'call-1',
          toolName: 'getWeatherForecast',
          input: { location: 'London' },
        },
        { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'call-1' },
      ],
    },
  ),
];

/**
 * The overlay assistant message after the user responded to the approval.
 * @param approved - The decision.
 * @returns The overlay message.
 */
const approvalRespondedOverlay = (approved: boolean): AI.UIMessage => ({
  id: 'a1',
  role: 'assistant',
  parts: [
    {
      type: 'dynamic-tool',
      toolName: 'getWeatherForecast',
      toolCallId: 'call-1',
      state: 'approval-responded',
      input: { location: 'London' },
      approval: { id: 'ap-1', approved },
    },
  ],
});

/** Inert initial value for a captured promise resolver. */
const noopResolve = (): void => {
  /* replaced by the promise executor */
};

/**
 * History for an open run mid-stream: start, then a text chunk in flight.
 * @returns The events, oldest-first.
 */
const openRunHistory = (): Event[] => [
  runStartEvent('run-1'),
  messageEvent(
    { codecMessageId: 'wire-a1', runId: 'run-1', role: 'assistant' },
    {
      outputs: [
        { type: 'start', messageId: 'a1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'partial' },
      ],
    },
  ),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatTransport', () => {
  describe('fresh send', () => {
    it('publishes the message body, POSTs the invocation pointer, and streams the run', async () => {
      const fetchMock = stubFetch({ runId: 'run-1' });
      const { fake, chat } = setup();

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));

      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toEqual({ kind: 'message', payload: userMessage('u1', 'hi') });
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ channelName: 'ai:test', eventId: 'ev-1' }),
        }),
      );

      fake.emit(
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-1' },
          {
            outputs: [
              { type: 'start', messageId: 'a1' },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'hello' },
            ],
          },
        ),
      );
      // Another run's output must not leak into this stream.
      fake.emit(
        messageEvent({ codecMessageId: 'wire-x', runId: 'run-other' }, { outputs: [{ type: 'text-end', id: 't9' }] }),
      );
      fake.emit(runEndEvent('run-other'));
      fake.emit(runEndEvent('run-1'));

      const chunks = await readAll(stream);
      expect(chunks).toEqual([
        { type: 'start', messageId: 'a1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'hello' },
      ]);
    });

    it('replays events that arrive before the POST names the run', async () => {
      let resolveFetch: (response: Response) => void = noopResolve;
      const fetchMock = vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { fake, chat } = setup();

      const pending = chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      // Let publishInput resolve so the POST is in flight.
      await Promise.resolve();
      fake.emit(
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-1' },
          { outputs: [{ type: 'text-delta', id: 't1', delta: 'early' }] },
        ),
      );
      resolveFetch(Response.json({ runId: 'run-1' }, { status: 200 }));

      const stream = await pending;
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream)).toEqual([{ type: 'text-delta', id: 't1', delta: 'early' }]);
    });

    it('closes the stream when the run suspends', async () => {
      stubFetch({ runId: 'run-1' });
      const { fake, chat } = setup();

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      fake.emit(runSuspendEvent('run-1'));

      expect(await readAll(stream)).toEqual([]);
    });

    it('rejects when the POST fails, with the send-failed code and the response status', async () => {
      stubFetch({ error: 'boom' }, 500);
      const { chat } = setup();

      await expect(chat.sendMessages(sendOptions([userMessage('u1', 'hi')]))).rejects.toBeErrorInfo({
        code: ErrorCode.SessionSendFailed,
        statusCode: 500,
        message: 'unable to send; chat request failed with status 500',
      });
    });

    it('cancels the run over the channel when the send is aborted', async () => {
      stubFetch({ runId: 'run-1' });
      const { fake, chat } = setup();
      const controller = new AbortController();

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi')], { abortSignal: controller.signal }));
      controller.abort();

      expect(fake.cancelled).toEqual(['run-1']);
    });

    it('reports streaming while a run stream is open', async () => {
      stubFetch({ runId: 'run-1' });
      const { fake, chat } = setup();
      const transitions: boolean[] = [];
      chat.onStreamingChange((streaming) => transitions.push(streaming));

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      expect(chat.streaming).toBe(true);
      fake.emit(runEndEvent('run-1'));
      await readAll(stream);

      expect(chat.streaming).toBe(false);
      expect(transitions).toEqual([true, false]);
    });
  });

  describe('regeneration', () => {
    it('publishes the wire-only regenerate with structure from the named target', async () => {
      const fetchMock = stubFetch({ runId: 'run-2' });
      const { fake, chat } = setup([...approvalGapEvents('run-1'), runEndEvent('run-1')]);

      const stream = await chat.sendMessages(
        sendOptions([userMessage('u1', 'forecast please')], { trigger: 'regenerate-message', messageId: 'a1' }),
      );

      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toEqual({ kind: 'regenerate' });
      expect(fake.published[0]?.opts).toEqual({ regenerates: 'wire-a1', parent: 'wire-u1' });
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat',
        expect.objectContaining({ body: JSON.stringify({ channelName: 'ai:test', eventId: 'ev-1' }) }),
      );

      fake.emit(runEndEvent('run-2'));
      expect(await readAll(stream)).toEqual([]);
    });

    it('falls back to the newest assistant when useChat names no target', async () => {
      stubFetch({ runId: 'run-2' });
      const { fake, chat } = setup([...approvalGapEvents('run-1'), runEndEvent('run-1')]);

      await chat.sendMessages(sendOptions([userMessage('u1', 'forecast please')], { trigger: 'regenerate-message' }));

      expect(fake.published[0]?.opts).toEqual({ regenerates: 'wire-a1', parent: 'wire-u1' });
    });

    it('throws when no wire identity is known for the target', async () => {
      stubFetch({ runId: 'run-2' });
      const { chat } = setup();

      await expect(
        chat.sendMessages(sendOptions([userMessage('u1', 'hi')], { trigger: 'regenerate-message', messageId: 'a1' })),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('continuation', () => {
    it('publishes an approval decision under the suspended run and POSTs a continuation', async () => {
      const fetchMock = stubFetch({ runId: 'run-9' });
      const { fake, chat } = setup(approvalGapEvents('run-9'));

      const stream = await chat.sendMessages(
        sendOptions([userMessage('u1', 'forecast please'), approvalRespondedOverlay(true)]),
      );

      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toEqual({
        kind: 'approval',
        payload: { toolCallId: 'call-1', approved: true },
      });
      expect(fake.published[0]?.opts).toEqual({ codecMessageId: 'wire-a1', runId: 'run-9' });
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat',
        expect.objectContaining({
          body: JSON.stringify({ channelName: 'ai:test', eventId: 'ev-1', runId: 'run-9' }),
        }),
      );

      fake.emit(runEndEvent('run-9'));
      expect(await readAll(stream)).toEqual([]);
    });

    it('publishes the provider tool-output chunk for a client-executed tool', async () => {
      stubFetch({ runId: 'run-9' });
      const gap: Event[] = [
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-9', role: 'assistant' },
          {
            outputs: [
              { type: 'start', messageId: 'a1' },
              { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'getLocation' },
              { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'getLocation', input: {} },
            ],
          },
        ),
      ];
      const { fake, chat } = setup(gap);
      const overlay: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getLocation',
            toolCallId: 'call-1',
            state: 'output-available',
            input: {},
            output: { latitude: 1, longitude: 2 },
          },
        ],
      };

      await chat.sendMessages(sendOptions([overlay]));

      expect(fake.published[0]?.event).toEqual({
        kind: 'chunk',
        payload: {
          type: 'tool-output-available',
          toolCallId: 'call-1',
          output: { latitude: 1, longitude: 2 },
          dynamic: true,
        },
      });
      expect(fake.published[0]?.opts).toEqual({ codecMessageId: 'wire-a1', runId: 'run-9' });
    });

    it('publishes the tool-output-error chunk for a failed client tool', async () => {
      stubFetch({ runId: 'run-9' });
      const gap: Event[] = [
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-9', role: 'assistant' },
          {
            outputs: [
              { type: 'start', messageId: 'a1' },
              { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'getLocation', input: {} },
            ],
          },
        ),
      ];
      const { fake, chat } = setup(gap);
      const overlay: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getLocation',
            toolCallId: 'call-1',
            state: 'output-error',
            input: {},
            errorText: 'denied',
          },
        ],
      };

      await chat.sendMessages(sendOptions([overlay]));

      expect(fake.published[0]?.event).toEqual({
        kind: 'chunk',
        payload: { type: 'tool-output-error', toolCallId: 'call-1', errorText: 'denied', dynamic: true },
      });
    });

    it('returns a closed stream and publishes nothing when the wire already holds every resolution', async () => {
      const fetchMock = stubFetch({ runId: 'run-9' });
      // The agent itself resolved the tool (a provider-executed call): the
      // resolution is an output chunk, and the published set counts it.
      const gap: Event[] = [
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-9', role: 'assistant' },
          {
            outputs: [
              { type: 'start', messageId: 'a1' },
              { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'getLocation' },
              { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'getLocation', input: {} },
              { type: 'tool-output-available', toolCallId: 'call-1', output: { latitude: 1, longitude: 2 } },
            ],
          },
        ),
      ];
      const { fake, chat } = setup(gap);
      const overlay: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getLocation',
            toolCallId: 'call-1',
            state: 'output-available',
            input: {},
            output: { latitude: 1, longitude: 2 },
          },
        ],
      };

      const stream = await chat.sendMessages(sendOptions([overlay]));

      expect(fake.published).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readAll(stream)).toEqual([]);
    });

    it('skips a resolution another client already published as an action', async () => {
      const fetchMock = stubFetch({ runId: 'run-9' });
      const gap: Event[] = [
        ...approvalGapEvents('run-9'),
        // Another client's approval action, observed on the wire.
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-9', serial: 'serial-3' },
          { inputs: [{ kind: 'approval', payload: { toolCallId: 'call-1', approved: true } }] },
        ),
      ];
      const { fake, chat } = setup(gap);

      const stream = await chat.sendMessages(
        sendOptions([userMessage('u1', 'forecast please'), approvalRespondedOverlay(true)]),
      );

      expect(fake.published).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readAll(stream)).toEqual([]);
    });

    it('throws when the suspended run-id is unknown', async () => {
      stubFetch({ runId: 'run-9' });
      // Assistant events with no run-id header, so no wire identity carries a
      // run to continue.
      const { chat } = setup(approvalGapEvents());

      await expect(
        chat.sendMessages(sendOptions([userMessage('u1', 'forecast please'), approvalRespondedOverlay(true)])),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('publishes the tool output for an approved call whose approval is already published', async () => {
      stubFetch({ runId: 'run-9' });
      const { fake, chat } = setup(approvalGapEvents('run-9'));

      // The approval decision goes out first.
      await chat.sendMessages(sendOptions([userMessage('u1', 'forecast please'), approvalRespondedOverlay(true)]));
      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toMatchObject({ kind: 'approval' });

      // The client then executes the approved tool; its output is a separate
      // action on the same call and must still publish.
      const executed: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getWeatherForecast',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { location: 'London' },
            output: { forecast: 'sunny' },
          },
        ],
      };
      await chat.sendMessages(sendOptions([userMessage('u1', 'forecast please'), executed]));

      expect(fake.published).toHaveLength(2);
      expect(fake.published[1]?.event).toEqual({
        kind: 'chunk',
        payload: {
          type: 'tool-output-available',
          toolCallId: 'call-1',
          output: { forecast: 'sunny' },
          dynamic: true,
        },
      });
    });

    it('skips a wire-held approval but still publishes the output for the same call', async () => {
      stubFetch({ runId: 'run-9' });
      // Another client's approval decision is already on the wire.
      const gap: Event[] = [
        ...approvalGapEvents('run-9'),
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-9', serial: 'serial-approval' },
          { inputs: [{ kind: 'approval', payload: { toolCallId: 'call-1', approved: true } }] },
        ),
      ];
      const { fake, chat } = setup(gap);
      const executed: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getWeatherForecast',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { location: 'London' },
            output: { forecast: 'sunny' },
          },
        ],
      };

      await chat.sendMessages(sendOptions([userMessage('u1', 'forecast please'), executed]));

      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toMatchObject({ kind: 'chunk' });
    });
  });

  describe('wire-identity tracking', () => {
    it('indexes live events observed before seed() after the older gap events', async () => {
      const fetchMock = stubFetch({ runId: 'run-9' });
      const fake = new FakeClientTransport();
      const chat = createChatTransport({ transport: fake, channelName: 'ai:test' });
      // A live event lands during hydration: another client resolved call-1.
      fake.emit(
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-9', serial: 'serial-9' },
          {
            inputs: [
              {
                kind: 'chunk',
                payload: { type: 'tool-output-available', toolCallId: 'call-1', output: { latitude: 1, longitude: 2 } },
              },
            ],
          },
        ),
      );
      // Seeding indexes the older gap (the unresolved tool call) first, then
      // the held-back live resolution on top.
      chat.seed([
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-9', role: 'assistant' },
          {
            outputs: [
              { type: 'start', messageId: 'a1' },
              { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'getLocation' },
              { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'getLocation', input: {} },
            ],
          },
        ),
      ]);

      const overlay: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getLocation',
            toolCallId: 'call-1',
            state: 'output-available',
            input: {},
            output: { latitude: 1, longitude: 2 },
          },
        ],
      };
      const stream = await chat.sendMessages(sendOptions([overlay]));

      // The wire already holds the resolution, so nothing is republished.
      expect(fake.published).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readAll(stream)).toEqual([]);
    });
  });

  describe('reconnectToStream', () => {
    it('replays the open run from history, then goes live', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [{ events: openRunHistory(), exhausted: true }];

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });

      expect(stream).not.toBeNull();
      if (!stream) return;
      // Live continuation after the replay.
      fake.emit(
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-1' },
          { outputs: [{ type: 'text-delta', id: 't1', delta: ' rest' }] },
        ),
      );
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream)).toEqual([
        { type: 'start', messageId: 'a1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'partial' },
        { type: 'text-delta', id: 't1', delta: ' rest' },
      ]);
    });

    it('returns null when the newest run has ended', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [{ events: [...openRunHistory(), runEndEvent('run-1')], exhausted: true }];

      expect(await chat.reconnectToStream({ chatId: 'ai:test' })).toBeNull();
    });

    it('returns null for a suspended run — the continuation path owns it', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [{ events: [...openRunHistory(), runSuspendEvent('run-1')], exhausted: true }];

      expect(await chat.reconnectToStream({ chatId: 'ai:test' })).toBeNull();
    });

    it('returns null when history holds no runs at all', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [{ events: [], exhausted: true }];

      expect(await chat.reconnectToStream({ chatId: 'ai:test' })).toBeNull();
    });

    it('resumes the newest of two open runs', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-old', 'serial-1'),
            runStartEvent('run-new', 'serial-2'),
            messageEvent(
              { codecMessageId: 'wire-new', runId: 'run-new' },
              { outputs: [{ type: 'text-delta', id: 't2', delta: 'newest' }] },
            ),
          ],
          exhausted: true,
        },
      ];

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });

      expect(stream).not.toBeNull();
      if (!stream) return;
      fake.emit(runEndEvent('run-new'));
      expect(await readAll(stream)).toEqual([{ type: 'text-delta', id: 't2', delta: 'newest' }]);
    });

    it('returns null when the open run start lies beyond the scan bound', async () => {
      const fake = new FakeClientTransport();
      const chat = createChatTransport({ transport: fake, channelName: 'ai:test', reconnectScanPages: 2 });
      chat.seed([]);
      // Two pages of output only — the run's ai-run-start is further back.
      fake.historyBatches = [
        {
          events: [
            messageEvent(
              { codecMessageId: 'wire-a1', runId: 'run-1' },
              { outputs: [{ type: 'text-delta', id: 't1', delta: 'late' }] },
            ),
          ],
          exhausted: false,
        },
        {
          events: [
            messageEvent(
              { codecMessageId: 'wire-a1', runId: 'run-1' },
              { outputs: [{ type: 'text-delta', id: 't1', delta: 'earlier' }] },
            ),
          ],
          exhausted: false,
        },
      ];

      expect(await chat.reconnectToStream({ chatId: 'ai:test' })).toBeNull();
    });

    it('classifies and replays from seeded events without paging history', async () => {
      // The application's hydration walk already consumed the transport's
      // history cursor, so paging would see nothing — the scan must classify
      // from the seed instead.
      const { fake, chat } = setup(openRunHistory());

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });

      expect(fake.historyCalls).toBe(0);
      expect(stream).not.toBeNull();
      if (!stream) return;
      fake.emit(
        messageEvent(
          { codecMessageId: 'wire-a1', runId: 'run-1' },
          { outputs: [{ type: 'text-delta', id: 't1', delta: ' rest' }] },
        ),
      );
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream)).toEqual([
        { type: 'start', messageId: 'a1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'partial' },
        { type: 'text-delta', id: 't1', delta: ' rest' },
      ]);
    });

    it('returns null from seeded events when the newest run has ended, without paging', async () => {
      const { fake, chat } = setup([...openRunHistory(), runEndEvent('run-1')]);

      expect(await chat.reconnectToStream({ chatId: 'ai:test' })).toBeNull();
      expect(fake.historyCalls).toBe(0);
    });

    it('replays a run classified from live events observed since seed', async () => {
      const { fake, chat } = setup();
      for (const event of openRunHistory()) fake.emit(event);

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });

      expect(fake.historyCalls).toBe(0);
      expect(stream).not.toBeNull();
      if (!stream) return;
      fake.emit(runEndEvent('run-1'));
      expect(await readAll(stream)).toEqual([
        { type: 'start', messageId: 'a1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'partial' },
      ]);
    });

    it('closes cleanly when the run ends between the scan and the live phase', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [{ events: openRunHistory(), exhausted: true }];

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      expect(stream).not.toBeNull();
      if (!stream) return;
      // The run ends immediately — the replay finishes and the stream closes;
      // nothing hangs.
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream)).toEqual([
        { type: 'start', messageId: 'a1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'partial' },
      ]);
    });
  });

  describe('close', () => {
    it('stops delivery and drops streaming', async () => {
      stubFetch({ runId: 'run-1' });
      const { fake, chat } = setup();

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      expect(chat.streaming).toBe(true);
      chat.close();

      expect(chat.streaming).toBe(false);
      // Delivery after close reaches no collector, and a send rejects with
      // the closed error before anything reaches the wire.
      fake.emit(runEndEvent('run-1'));
      await expect(chat.sendMessages(sendOptions([userMessage('u2', 'again')]))).rejects.toBeErrorInfo({
        code: ErrorCode.SessionClosed,
        statusCode: 400,
        message: 'unable to send; the chat transport is closed',
      });
      expect(fake.published.filter((p) => p.event.kind === 'message')).toHaveLength(1);
    });
  });
});
