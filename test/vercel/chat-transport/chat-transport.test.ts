import * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { type Logger, LogLevel, makeLogger } from '../../../src/logger.js';
import { type AblyChatTransport, type ChatTransportOptions, createChatTransport } from '../../../src/vercel/index.js';
import { makePaginated } from '../../helper/mock-channel.js';
import { drain, flushMicrotasks, nextMacrotask } from '../../helper/streams.js';
import {
  type ChannelFixture,
  channelWith,
  failedToStart,
  failedTurn,
  gate,
  movingThroughStates,
  textTurn,
  wireAcross,
  wireOf,
} from './fixtures.js';

type SendMessagesOptions = Parameters<AblyChatTransport['sendMessages']>[0];
type ActiveTurnFn = NonNullable<ChatTransportOptions['activeTurn']>;
type ActiveTurnAnswer = Awaited<ReturnType<ActiveTurnFn>>;

/** What `activeTurn` resolves with when nothing is running. */
// eslint-disable-next-line unicorn/no-null -- activeTurn says "nothing is running" with null
const NOTHING_RUNNING: ActiveTurnAnswer = null;

/**
 * An `activeTurn` that always gives the same answer.
 * @param answer - The answer.
 * @returns The mock.
 */
const answering = (answer: ActiveTurnAnswer): Mock<ActiveTurnFn> => vi.fn<ActiveTurnFn>().mockResolvedValue(answer);

const prompt: AI.UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello?' }] };
const reply = textTurn('t1', ['Hel', 'lo']);

/**
 * What `useChat` passes to `sendMessages` for a new prompt.
 * @param overrides - Fields to change.
 * @returns The options.
 */
const sendOptions = (overrides: Partial<SendMessagesOptions> = {}): SendMessagesOptions => ({
  trigger: 'submit-message',
  chatId: 'chat-1',
  messageId: undefined,
  messages: [prompt],
  abortSignal: undefined,
  ...overrides,
});

/**
 * A logger that records what it is asked to log at error level.
 * @returns The logger and the messages it recorded.
 */
const recordingLogger = (): { logger: Logger; errors: string[] } => {
  const errors: string[] = [];
  const logger = makeLogger({
    logLevel: LogLevel.Error,
    logHandler: (message: string) => {
      errors.push(message);
    },
  });
  return { logger, errors };
};

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(undefined, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * A chat transport on a mock channel whose history holds `stored`.
 * @param stored - What history holds.
 * @param options - Options beyond the client and channel name.
 * @returns The transport and its channel.
 */
const setup = (
  stored: Ably.InboundMessage[] = [],
  options: Partial<ChatTransportOptions> = {},
): { transport: AblyChatTransport; fixture: ChannelFixture } => {
  const fixture = channelWith(stored);
  const transport = createChatTransport({ client: fixture.client, channelName: 'chat', ...options });
  return { transport, fixture };
};

/**
 * The first request the transport posted.
 * @returns Its URL and init.
 */
const posted = (): { url: string; init: RequestInit } => {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  // CAST: the transport posts to a string URL with an init.
  return { url: url as string, init: init ?? {} };
};

describe('createChatTransport', () => {
  it('rejects an empty channel name, and logs it', () => {
    const { logger, errors } = recordingLogger();
    const fixture = channelWith();
    expect(() => createChatTransport({ client: fixture.client, channelName: '', logger })).toThrowErrorInfo({
      code: ErrorCode.InvalidArgument,
      message: 'unable to create chat transport; channelName must be a non-empty string',
    });
    expect(errors).toEqual(['ChatTransport(); channel name is empty']);
  });

  it('declares that a resumed stream replays its turn from the start', () => {
    const { transport } = setup();
    expect(transport.resumeStreamIsReplay).toBe(true);
  });

  it('resolves the channel with its options when created, and attaches it only on first use', () => {
    const { fixture } = setup();

    const [name, options] = fixture.client.channels.get.mock.calls[0] ?? [];
    expect(name).toBe('chat');
    expect(typeof options?.params?.agent).toBe('string');
    expect(fixture.channel.on).not.toHaveBeenCalled();
    expect(fixture.channel.subscribe).not.toHaveBeenCalled();
    expect(fixture.channel.attach).not.toHaveBeenCalled();
  });
});

describe('sendMessages', () => {
  it('reads the channel before it posts the turn', async () => {
    const { transport, fixture } = setup();

    await transport.sendMessages(sendOptions());

    const [subscribed] = fixture.channel.subscribe.mock.invocationCallOrder;
    const [read] = fixture.channel.history.mock.invocationCallOrder;
    const [post] = fetchMock.mock.invocationCallOrder;
    expect(subscribed).toBeLessThan(post ?? 0);
    expect(read).toBeLessThan(post ?? 0);
    expect(fixture.channel.publish).not.toHaveBeenCalled();
  });

  it('posts the turn as JSON to /api/chat, with the request’s body, headers and signal', async () => {
    const { transport } = setup();
    const controller = new AbortController();

    await transport.sendMessages(
      sendOptions({
        trigger: 'regenerate-message',
        messageId: 'a1',
        abortSignal: controller.signal,
        headers: { authorization: 'Bearer token' },
        body: { model: 'fast', chatId: 'overridden' },
      }),
    );

    const { url, init } = posted();
    expect(url).toBe('/api/chat');
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer token');
    // CAST: the transport posts a JSON string.
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'fast',
      chatId: 'chat-1',
      trigger: 'regenerate-message',
      messageId: 'a1',
      messages: [prompt],
    });
  });

  it('posts to the endpoint the options name, keeping a content type the request sets', async () => {
    const { transport } = setup([], { api: '/chat/turns' });

    await transport.sendMessages(
      sendOptions({ headers: new Headers({ 'content-type': 'application/vnd.turn+json' }) }),
    );

    const { url, init } = posted();
    expect(url).toBe('/chat/turns');
    expect(new Headers(init.headers).get('content-type')).toBe('application/vnd.turn+json');
  });

  it('rejects with InvalidArgument, reading and posting nothing, when the request cannot be built', async () => {
    const { transport, fixture } = setup();

    await expect(transport.sendMessages(sendOptions({ headers: { 'bad header': 'x' } }))).rejects.toBeErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );
    expect(fixture.channel.subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names no header value when the request headers are invalid, since one can be a credential', async () => {
    const logged: unknown[] = [];
    const logger = makeLogger({
      logLevel: LogLevel.Trace,
      logHandler: (message, _level, context) => {
        logged.push(message, context);
      },
    });
    const { transport } = setup([], { logger });

    const sending = transport.sendMessages(
      sendOptions({ headers: { authorization: 'Basic dXNlcjpzM2NyZXQ=\nwrapped' } }),
    );

    await expect(sending).rejects.toBeErrorInfo({
      code: ErrorCode.InvalidArgument,
      message: 'unable to send messages; the request headers are not valid HTTP headers',
    });
    expect(JSON.stringify(logged)).not.toContain('dXNlcjpzM2NyZXQ=');
  });

  it('streams the turn that starts after the post, from its start chunk to its terminal chunk', async () => {
    const { transport, fixture } = setup();
    const stream = await transport.sendMessages(sendOptions());

    fixture.deliver(wireOf(reply).live);

    expect(await drain(stream)).toEqual(reply);
  });

  it('waits until the turn running when it is called has ended, then streams the next turn alone', async () => {
    const running = textTurn('t0', ['Old', ' text'], 'abort');
    const wire = wireAcross(running.slice(0, 3), [...running.slice(3), ...reply]);
    const tail = wire.live.slice(0, running.length - 3);
    const { transport, fixture } = setup(wire.stored);

    const sending = transport.sendMessages(sendOptions());
    await nextMacrotask();
    expect(fetchMock).not.toHaveBeenCalled();
    fixture.deliver(tail);
    const stream = await sending;
    fixture.deliver(wire.live.slice(tail.length));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await drain(stream)).toEqual(reply);
  });

  it('ends the reply on an error the agent publishes before anything else', async () => {
    const { transport, fixture } = setup(wireOf(textTurn('t0', ['Old'])).stored);
    const stream = await transport.sendMessages(sendOptions());

    fixture.deliver(wireAcross(textTurn('t0', ['Old']), [failedToStart]).live);

    expect(await drain(stream)).toEqual([failedToStart]);
  });

  it('errors the stream with SessionMessageProcessingFailed when a message of its turn cannot be decoded', async () => {
    const { transport, fixture } = setup();
    const stream = await transport.sendMessages(sendOptions());
    const wire = wireOf(reply).live;

    fixture.deliver(wire.slice(0, -1));
    // CAST: the turn's finish message, its data replaced with what its row cannot decode.
    fixture.deliver([{ ...wire.at(-1), data: 'not an object' } as Ably.InboundMessage]);

    await expect(drain(stream)).rejects.toBeErrorInfoWithCode(ErrorCode.SessionMessageProcessingFailed);
  });

  it('errors the stream with SessionSendFailed when the backend answers outside 2xx', async () => {
    fetchMock.mockResolvedValue(new Response('the agent is down', { status: 503 }));
    const { transport } = setup();

    const stream = await transport.sendMessages(sendOptions());

    await expect(drain(stream)).rejects.toBeErrorInfo({
      code: ErrorCode.SessionSendFailed,
      statusCode: 503,
      message: 'unable to send messages; /api/chat answered 503: the agent is down',
    });
  });

  it('names the status text when the backend’s error body is empty or cannot be read, and cuts a long one short', async () => {
    const unreadable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.error(new TypeError('connection reset'));
      },
    });
    fetchMock
      .mockResolvedValueOnce(new Response(undefined, { status: 502, statusText: 'Bad Gateway' }))
      .mockResolvedValueOnce(new Response(unreadable, { status: 500, statusText: 'Internal Server Error' }))
      .mockResolvedValueOnce(new Response('x'.repeat(500), { status: 500 }));
    const { transport } = setup();

    const empty = await transport.sendMessages(sendOptions());
    await expect(drain(empty)).rejects.toBeErrorInfo({
      message: 'unable to send messages; /api/chat answered 502: Bad Gateway',
    });
    const failed = await transport.sendMessages(sendOptions());
    await expect(drain(failed)).rejects.toBeErrorInfo({
      message: 'unable to send messages; /api/chat answered 500: Internal Server Error',
    });
    const long = await transport.sendMessages(sendOptions());
    await expect(drain(long)).rejects.toBeErrorInfo({
      message: `unable to send messages; /api/chat answered 500: ${'x'.repeat(200)}…`,
    });
  });

  it('logs a failed post by its status, or by its reason when the request itself failed', async () => {
    const logHandler = vi.fn();
    const logger = makeLogger({ logLevel: LogLevel.Error, logHandler });
    fetchMock
      .mockResolvedValueOnce(new Response('the conversation, echoed', { status: 503 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { transport } = setup([], { logger });

    await expect(drain(await transport.sendMessages(sendOptions()))).rejects.toBeErrorInfoWithCode(
      ErrorCode.SessionSendFailed,
    );
    await expect(drain(await transport.sendMessages(sendOptions()))).rejects.toBeErrorInfoWithCode(
      ErrorCode.SessionSendFailed,
    );

    expect(logHandler).toHaveBeenCalledTimes(2);
    expect(logHandler).toHaveBeenNthCalledWith(
      1,
      'ChatTransport.sendMessages(); the request failed',
      LogLevel.Error,
      expect.objectContaining({ status: 503 }),
    );
    expect(logHandler).toHaveBeenNthCalledWith(
      2,
      'ChatTransport.sendMessages(); the request failed',
      LogLevel.Error,
      expect.objectContaining({ error: 'unable to send messages; Failed to fetch' }),
    );
    expect(JSON.stringify(logHandler.mock.calls)).not.toContain('echoed');
  });

  it('errors the stream with SessionSendFailed when the request fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { transport } = setup();

    const stream = await transport.sendMessages(sendOptions());

    await expect(drain(stream)).rejects.toBeErrorInfo({
      code: ErrorCode.SessionSendFailed,
      statusCode: 500,
      message: 'unable to send messages; Failed to fetch',
    });
  });

  it('rejects with InvalidArgument, posting nothing, when the body cannot be made into JSON', async () => {
    const { transport } = setup();
    const body = {
      toJSON: (): never => {
        throw new Error('this body has no JSON form');
      },
    };

    await expect(transport.sendMessages(sendOptions({ body }))).rejects.toBeErrorInfo({
      code: ErrorCode.InvalidArgument,
      message: 'unable to send messages; this body has no JSON form',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs nothing above debug when the request is aborted with the reply useChat stopped', async () => {
    const logHandler = vi.fn();
    const { transport } = setup([], { logger: makeLogger({ logLevel: LogLevel.Info, logHandler }) });
    const request = Promise.withResolvers<Response>();
    fetchMock.mockReturnValue(request.promise);
    const controller = new AbortController();
    const stream = await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));
    logHandler.mockClear();

    controller.abort();
    request.reject(new DOMException('This operation was aborted', 'AbortError'));
    await nextMacrotask();

    await expect(drain(stream)).rejects.toHaveProperty('name', 'AbortError');
    expect(logHandler).not.toHaveBeenCalled();
  });

  it('keeps a reply that ended before its request failed', async () => {
    const request = Promise.withResolvers<Response>();
    fetchMock.mockReturnValue(request.promise);
    const { transport, fixture } = setup();
    const stream = await transport.sendMessages(sendOptions());

    fixture.deliver(wireOf(reply).live);
    request.reject(new TypeError('network error'));
    await flushMicrotasks();

    expect(await drain(stream)).toEqual(reply);
  });

  it('rejects with OperationCancelled, posting nothing, when stopped while it opens the channel', async () => {
    const onStop = vi.fn();
    const { transport } = setup([], { onStop });
    const controller = new AbortController();

    const sending = transport.sendMessages(sendOptions({ abortSignal: controller.signal }));
    controller.abort();

    await expect(sending).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await expect(sending).rejects.toHaveProperty('name', 'AbortError');
    await nextMacrotask();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('ends the stream with OperationCancelled when stopped mid-reply, then calls onStop', async () => {
    const onStop = vi.fn();
    const { transport, fixture } = setup([], { onStop });
    const controller = new AbortController();
    const stream = await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));
    const wire = wireOf(reply).live;
    fixture.deliver(wire.slice(0, 2));

    controller.abort();
    fixture.deliver(wire.slice(2));
    expect(onStop).not.toHaveBeenCalled();
    await flushMicrotasks();

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith({ chatId: 'chat-1', channel: fixture.channel });
    const read = stream.getReader().read();
    await expect(read).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await expect(read).rejects.toHaveProperty('name', 'AbortError');
  });

  it('ends the stream as a stop when no onStop is given', async () => {
    const { transport } = setup();
    const controller = new AbortController();
    const stream = await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));

    controller.abort();
    await nextMacrotask();

    await expect(drain(stream)).rejects.toHaveProperty('name', 'AbortError');
  });

  it('does not call onStop for an abort after the reply ended, or for a reply useChat cancels', async () => {
    const onStop = vi.fn();
    const { transport, fixture } = setup([], { onStop });
    const controller = new AbortController();
    const finished = await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));
    fixture.deliver(wireOf(reply).live);
    await drain(finished);
    controller.abort();

    const cancelled = await transport.sendMessages(sendOptions());
    await cancelled.cancel();
    await nextMacrotask();

    expect(onStop).not.toHaveBeenCalled();
  });

  it('logs an onStop that throws, or an async one that rejects', async () => {
    const { logger, errors } = recordingLogger();
    const failures = [
      vi.fn(() => {
        throw new Error('the cancel endpoint is down');
      }),
      vi.fn(async () => {
        await Promise.resolve();
        throw new Error('the cancel endpoint is down');
      }),
    ];
    for (const onStop of failures) {
      const { transport } = setup([], { logger, onStop });
      const controller = new AbortController();
      const stream = await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));

      controller.abort();
      await nextMacrotask();

      await expect(drain(stream)).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
      expect(onStop).toHaveBeenCalledTimes(1);
    }
    expect(errors).toEqual(['ChatTransport; onStop threw', 'ChatTransport; onStop threw']);
  });

  it('rejects with SessionSubscriptionFailed when the channel cannot be attached, and tries again on the next call', async () => {
    const { transport, fixture } = setup();
    fixture.channel.attach.mockRejectedValue(new Ably.ErrorInfo('channel failed', 90000, 400));

    await expect(transport.sendMessages(sendOptions())).rejects.toBeErrorInfo({
      code: ErrorCode.SessionSubscriptionFailed,
      cause: { message: 'channel failed' },
    });

    fixture.channel.attach.mockReset();
    const stream = await transport.sendMessages(sendOptions());
    fixture.deliver(wireOf(reply).live);
    expect(await drain(stream)).toEqual(reply);
  });

  describe('while the latest turn’s agent is publishing', () => {
    const stopped = textTurn('t0', ['Old', ' text'], 'abort');
    const wire = wireOf([...stopped, ...reply]).live;
    const opening = wire.slice(0, 3);
    const tail = wire.slice(3, stopped.length);
    const next = wire.slice(stopped.length);

    /**
     * A transport that streamed the opening of a turn and was stopped.
     * @returns The transport and its channel.
     */
    const stoppedMidTurn = async (): Promise<{ transport: AblyChatTransport; fixture: ChannelFixture }> => {
      const { transport, fixture } = setup([], { onStop: vi.fn() });
      const controller = new AbortController();
      await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));
      fixture.deliver(opening);
      controller.abort();
      await flushMicrotasks();
      return { transport, fixture };
    };

    it('posts once a turn this tab stopped has ended, and streams the next turn', async () => {
      const { transport, fixture } = await stoppedMidTurn();

      const sending = transport.sendMessages(sendOptions());
      await nextMacrotask();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fixture.deliver(tail);
      const stream = await sending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fixture.deliver(next);

      expect(await drain(stream)).toEqual(reply);
    });

    it('posts at once when the stopped turn has already ended', async () => {
      const { transport, fixture } = await stoppedMidTurn();
      fixture.deliver(tail);

      const stream = await transport.sendMessages(sendOptions());
      fixture.deliver(next);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await drain(stream)).toEqual(reply);
    });

    it('posts nothing when stopped while it waits', async () => {
      const { transport, fixture } = await stoppedMidTurn();
      const controller = new AbortController();

      const waiting = transport.sendMessages(sendOptions({ abortSignal: controller.signal }));
      await nextMacrotask();
      controller.abort();

      await expect(waiting).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fixture.deliver(tail);
      await transport.sendMessages(sendOptions());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps waiting for a turn that starts while it waits, such as one from another tab', async () => {
      const { transport, fixture } = await stoppedMidTurn();
      const other = textTurn('t9', ['Other']);
      const otherWire = wireOf([...stopped, ...other]).live.slice(stopped.length);

      const sending = transport.sendMessages(sendOptions());
      await nextMacrotask();
      fixture.deliver(otherWire.slice(0, 2));
      await nextMacrotask();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fixture.deliver(otherWire.slice(2));
      await sending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops waiting for a running turn that publishes nothing for 10 seconds', async () => {
      vi.useFakeTimers();
      const { transport, fixture } = await stoppedMidTurn();

      const sending = transport.sendMessages(sendOptions());
      await vi.advanceTimersByTimeAsync(9000);
      fixture.deliver(tail.slice(0, 1));
      await vi.advanceTimersByTimeAsync(9999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await sending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('waits for a turn read from history whose text was appended to a moment ago, though created long ago', async () => {
      const now = Date.now();
      const running = wireAcross(reply.slice(0, 3), reply.slice(3));
      const stored = running.stored.map((message) => ({
        ...message,
        timestamp: now - 60_000,
        version: { ...message.version, timestamp: now - 1000 },
      }));
      const { transport, fixture } = setup(stored);

      const sending = transport.sendMessages(sendOptions());
      await nextMacrotask();
      expect(fetchMock).not.toHaveBeenCalled();
      fixture.deliver(running.live);
      await sending;

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('waits on the next read of the channel when the read it waits on loses continuity', async () => {
      const retried = textTurn('t2', ['Bye']);
      const wire = wireAcross(reply.slice(0, 3), [...reply.slice(3), ...retried]);
      const tail = wire.live.slice(0, reply.length - 3);
      const { transport, fixture } = setup(wire.stored);
      const first = transport.sendMessages(sendOptions());
      await nextMacrotask();

      // The channel loses continuity, and a later call reads it again.
      fixture.channel.emitStateChange({ current: 'attached', previous: 'attached', resumed: false });
      const second = transport.sendMessages(sendOptions());
      await nextMacrotask();
      expect(fixture.channel.subscribe).toHaveBeenCalledTimes(2);
      expect(fetchMock).not.toHaveBeenCalled();

      fixture.deliver(tail);
      const stream = await first;
      await second;
      fixture.deliver(wire.live.slice(tail.length));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await drain(stream)).toEqual(retried);
    });

    it('posts nothing after close(), however soon after the wait it lands', async () => {
      const running = wireAcross(reply.slice(0, 3), reply.slice(3));
      // close() lands from 0 to 29 microtasks after the turn ends: before
      // the post, which it stops, or after it.
      for (let hops = 0; hops < 30; hops += 1) {
        const { transport, fixture } = setup(running.stored);
        fetchMock.mockClear();
        const closed = vi.fn();
        const sending = transport.sendMessages(sendOptions());
        await nextMacrotask();

        fixture.deliver(running.live);
        for (let hop = 0; hop < hops; hop += 1) await Promise.resolve();
        transport.close();
        closed();
        await Promise.allSettled([sending]);

        // vitest numbers every mock call in one sequence; 0 stands for no post.
        const [postedAt = 0] = fetchMock.mock.invocationCallOrder;
        const [closedAt = 0] = closed.mock.invocationCallOrder;
        expect(postedAt).toBeLessThan(closedAt);
      }
    });

    it('does not wait for a running turn whose history shows it went quiet long ago', async () => {
      const quiet = wireOf(reply.slice(0, 3)).stored.map((message) => ({ ...message, timestamp: Date.now() - 60_000 }));
      const { transport } = setup(quiet);

      await transport.sendMessages(sendOptions());

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('waits after an error for the finish the AI SDK writes after it, then streams the next turn', async () => {
      const failing = failedTurn('t1', 'Hel');
      const retried = textTurn('t2', ['Bye']);
      const wire = wireOf([...failing, ...retried]).live;
      const { transport, fixture } = setup();
      await transport.sendMessages(sendOptions());
      fixture.deliver(wire.slice(0, 4));

      const retrying = transport.sendMessages(sendOptions());
      await nextMacrotask();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fixture.deliver(wire.slice(4, failing.length));
      const stream = await retrying;
      fixture.deliver(wire.slice(failing.length));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await drain(stream)).toEqual(retried);
    });

    it('waits no more than 2 seconds after an error that arrives while it waits', async () => {
      vi.useFakeTimers();
      const { transport, fixture } = setup();
      await transport.sendMessages(sendOptions());
      const wire = wireOf(textTurn('t1', ['Hel'], 'error')).live;
      fixture.deliver(wire.slice(0, -1));

      const retrying = transport.sendMessages(sendOptions());
      await vi.advanceTimersByTimeAsync(5000);
      fixture.deliver(wire.slice(-1));
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await retrying;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps waiting after an error while the failed turn’s agent still writes, until its finish', async () => {
      vi.useFakeTimers();
      const { transport, fixture } = setup();
      await transport.sendMessages(sendOptions());
      // One merged stream failed: the AI SDK writes the error, then goes on
      // with the rest of the turn.
      const chunks: AI.UIMessageChunk[] = [
        ...reply.slice(0, 3),
        { type: 'error', errorText: 'the model failed' },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'still going' },
        { type: 'text-end', id: 't2' },
        { type: 'finish' },
      ];
      const wire = wireOf(chunks).live;
      fixture.deliver(wire.slice(0, 4));

      const retrying = transport.sendMessages(sendOptions());
      await vi.advanceTimersByTimeAsync(1500);
      fixture.deliver(wire.slice(4, 5));
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fixture.deliver(wire.slice(5));
      await retrying;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('waits no more than 2 seconds after an error for the finish after it', async () => {
      vi.useFakeTimers();
      const { transport, fixture } = setup();
      await transport.sendMessages(sendOptions());
      fixture.deliver(wireOf(textTurn('t1', ['Hel'], 'error')).live);

      const retrying = transport.sendMessages(sendOptions());
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await retrying;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects with OperationCancelled, posting nothing, when the transport closes while it waits', async () => {
      const { transport } = await stoppedMidTurn();

      const waiting = transport.sendMessages(sendOptions());
      await nextMacrotask();
      transport.close();

      await expect(waiting).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('close', () => {
  it('ends a reply still streaming as a stop for useChat, without calling onStop, then detaches the channel', async () => {
    const onStop = vi.fn();
    const { transport, fixture } = setup([], { onStop });
    const controller = new AbortController();
    const stream = await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));

    transport.close();
    // useChat's own stop, after the transport's close, stops nothing more.
    controller.abort();
    await nextMacrotask();

    expect(onStop).not.toHaveBeenCalled();
    await expect(drain(stream)).rejects.toHaveProperty('name', 'AbortError');
    expect(fixture.channel.listener).toBeUndefined();
    expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
  });

  it('keeps an abort just before it, with no await between, from calling onStop, as an unmount does', async () => {
    const onStop = vi.fn();
    const { transport } = setup([], { onStop });
    const controller = new AbortController();
    const stream = await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));

    controller.abort();
    transport.close();
    await nextMacrotask();

    expect(onStop).not.toHaveBeenCalled();
    await expect(drain(stream)).rejects.toHaveProperty('name', 'AbortError');
  });

  it('still calls onStop for an abort it follows after an await, as dispose() does', async () => {
    const onStop = vi.fn();
    const { transport } = setup([], { onStop });
    const controller = new AbortController();
    await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));

    controller.abort();
    await flushMicrotasks();
    transport.close();
    await nextMacrotask();

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('rejects a call still opening the channel with OperationCancelled, posting nothing', async () => {
    const { transport } = setup();

    const sending = transport.sendMessages(sendOptions());
    transport.close();

    await expect(sending).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await expect(sending).rejects.toHaveProperty('name', 'AbortError');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a call made just before it, on a channel already being read, posting nothing', async () => {
    const { transport } = setup();
    const first = await transport.sendMessages(sendOptions());
    await first.cancel();

    const sending = transport.sendMessages(sendOptions());
    transport.close();

    await expect(sending).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the channel again on the next call, once the previous read has let it go', async () => {
    const { transport, fixture } = setup();
    await transport.sendMessages(sendOptions());
    const detaching = gate();
    fixture.channel.detach.mockReturnValueOnce(detaching.promise);

    transport.close();
    const sending = transport.sendMessages(sendOptions());
    await nextMacrotask();
    expect(fixture.channel.subscribe).toHaveBeenCalledTimes(1);

    detaching.open();
    const stream = await sending;
    fixture.deliver(wireOf(reply).live);

    expect(fixture.channel.subscribe).toHaveBeenCalledTimes(2);
    expect(await drain(stream)).toEqual(reply);
  });

  it('waits for another transport closing on the same channel before it reads the channel', async () => {
    const { transport: previous, fixture } = setup();
    await previous.sendMessages(sendOptions());
    const detaching = gate();
    fixture.channel.detach.mockReturnValueOnce(detaching.promise);
    previous.close();

    const transport = createChatTransport({ client: fixture.client, channelName: 'chat' });
    const sending = transport.sendMessages(sendOptions());
    await nextMacrotask();
    expect(fixture.channel.subscribe).toHaveBeenCalledTimes(1);

    detaching.open();
    const stream = await sending;
    fixture.deliver(wireOf(reply).live);

    expect(fixture.channel.subscribe).toHaveBeenCalledTimes(2);
    expect(await drain(stream)).toEqual(reply);
  });

  it('opens a fresh read for a call made straight after it, which the next close releases', async () => {
    const { transport, fixture } = setup();

    const first = transport.sendMessages(sendOptions());
    transport.close();
    const second = transport.sendMessages(sendOptions());

    await expect(first).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    const stream = await second;
    transport.close();

    await expect(drain(stream)).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await nextMacrotask();
    expect(fixture.channel.listener).toBeUndefined();
    expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
  });

  it('reads the channel again on the next call after it lost continuity, ending a reply still open', async () => {
    const { transport, fixture } = setup();
    const open = await transport.sendMessages(sendOptions());

    fixture.channel.emitStateChange({ current: 'attached', previous: 'attaching', resumed: false });
    const stream = await transport.sendMessages(sendOptions());
    fixture.deliver(wireOf(reply).live);

    expect(fixture.channel.subscribe).toHaveBeenCalledTimes(2);
    expect(fixture.channel.history).toHaveBeenCalledTimes(2);
    const ended = drain(open);
    await expect(ended).rejects.toBeErrorInfo({
      code: ErrorCode.OperationCancelled,
      message: 'unable to read the turn; the channel lost continuity, and a later call read it again',
    });
    await expect(ended).rejects.toHaveProperty('name', 'AbortError');
    expect(await drain(stream)).toEqual(reply);
  });

  it('keeps the read it opens straight after it, through the detach and the attach that make that read', async () => {
    const { transport, fixture } = setup();
    movingThroughStates(fixture.channel);
    await transport.sendMessages(sendOptions());
    transport.close();
    await transport.sendMessages(sendOptions());

    await transport.sendMessages(sendOptions());

    expect(fixture.channel.subscribe).toHaveBeenCalledTimes(2);
    expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
  });

  it('keeps the read it opens after continuity was lost, through the detach and the attach that make that read', async () => {
    const { transport, fixture } = setup();
    movingThroughStates(fixture.channel);
    await transport.sendMessages(sendOptions());
    fixture.channel.emitStateChange({ current: 'attached', previous: 'attached', resumed: false });
    await transport.sendMessages(sendOptions());

    await transport.sendMessages(sendOptions());

    expect(fixture.channel.subscribe).toHaveBeenCalledTimes(2);
    expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
  });

  it('logs no error when it closes while the first read of the channel is in flight', async () => {
    const { logger, errors } = recordingLogger();
    const { transport, fixture } = setup([], { logger });
    const page = Promise.withResolvers<Ably.PaginatedResult<Ably.InboundMessage>>();
    fixture.channel.history.mockReturnValueOnce(page.promise);
    const sending = transport.sendMessages(sendOptions());
    await nextMacrotask();
    expect(fixture.channel.history).toHaveBeenCalledTimes(1);

    transport.close();
    page.resolve(makePaginated([]));

    await expect(sending).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await nextMacrotask();
    expect(errors).toEqual([]);
  });

  it('does nothing when the transport has not read the channel, and is safe to call twice', async () => {
    const { transport, fixture } = setup();

    transport.close();
    transport.close();
    await nextMacrotask();

    expect(fixture.channel.detach).not.toHaveBeenCalled();
  });
});

describe('reconnectToStream', () => {
  /** A turn that started before the transport read the channel, and goes on live. */
  const running = wireAcross(reply.slice(0, 3), reply.slice(3));

  describe('without activeTurn', () => {
    it('replays the turn running on the channel from its start chunk, then follows it live', async () => {
      const { transport, fixture } = setup(running.stored);

      const stream = await transport.reconnectToStream({ chatId: 'chat-1' });
      fixture.deliver(running.live);

      expect(await drain(stream)).toEqual(reply);
    });

    it('resolves null when the latest turn has finished', async () => {
      const { transport } = setup(wireOf([...reply, ...textTurn('t2', ['Bye'])]).stored);
      expect(await transport.reconnectToStream({ chatId: 'chat-1' })).toBeNull();
    });

    it('resolves null on a channel with no turn', async () => {
      const { transport } = setup();
      expect(await transport.reconnectToStream({ chatId: 'chat-1' })).toBeNull();
    });

    it('keeps reading after null, so a later call rejoins a turn that started in between', async () => {
      const { transport, fixture } = setup();
      expect(await transport.reconnectToStream({ chatId: 'chat-1' })).toBeNull();
      const wire = wireOf(reply).live;
      fixture.deliver(wire.slice(0, 3));

      const stream = await transport.reconnectToStream({ chatId: 'chat-1' });
      fixture.deliver(wire.slice(3));

      expect(fixture.channel.history).toHaveBeenCalledTimes(1);
      expect(await drain(stream)).toEqual(reply);
    });
  });

  describe('with activeTurn', () => {
    it('asks it about the chat, and resolves null when it says nothing is running, still reading the channel', async () => {
      const activeTurn = answering(NOTHING_RUNNING);
      const { transport, fixture } = setup(running.stored, { activeTurn });

      expect(await transport.reconnectToStream({ chatId: 'chat-1' })).toBeNull();
      expect(activeTurn).toHaveBeenCalledWith('chat-1');
      expect(fixture.channel.subscribe).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['{}', {}],
      // eslint-disable-next-line unicorn/no-null -- a JSON body says "no serial yet" with null
      ['a null from', { from: null }],
    ])('replays the turn running on the channel when it answers %s', async (_label, answer) => {
      const { transport, fixture } = setup(running.stored, { activeTurn: answering(answer) });

      const stream = await transport.reconnectToStream({ chatId: 'chat-1' });
      fixture.deliver(running.live);

      expect(await drain(stream)).toEqual(reply);
    });

    it('follows the next turn to start when it answers {} and none is running', async () => {
      const { transport, fixture } = setup(wireOf(textTurn('t0', ['Old'])).stored, {
        activeTurn: answering({}),
      });

      const stream = await transport.reconnectToStream({ chatId: 'chat-1' });
      fixture.deliver(wireAcross(textTurn('t0', ['Old']), reply).live);

      expect(await drain(stream)).toEqual(reply);
    });

    it('replays the turn that started at or after from, even one that has just finished', async () => {
      const finished = wireOf(reply);
      const from = finished.stored[0]?.serial ?? '';
      const { transport } = setup(finished.stored, { activeTurn: answering({ from }) });

      const stream = await transport.reconnectToStream({ chatId: 'chat-1' });

      expect(await drain(stream)).toEqual([
        { type: 'start' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello' },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ]);
    });

    it('follows the next turn to start when the turn on the channel began before from', async () => {
      const earlier = textTurn('t0', ['Old'], 'abort').slice(0, 3);
      const wire = wireAcross(earlier, [...textTurn('t0', ['Old'], 'abort').slice(3), ...reply]);
      const { transport, fixture } = setup(wire.stored, {
        activeTurn: answering({ from: 's9999' }),
      });

      const stream = await transport.reconnectToStream({ chatId: 'chat-1' });
      fixture.deliver(wire.live);

      expect(await drain(stream)).toEqual(reply);
    });

    it.each([
      ['undefined', undefined],
      ['a string', 'running'],
      ['a non-string from', { from: 7 }],
      ['an empty from', { from: '' }],
      ['an array', []],
      ['an instance of a class', new Map([['from', 's1']])],
    ])('rejects with InvalidArgument when it resolves %s', async (_label, answer) => {
      // CAST: an answer that breaks the contract, as one read off a response body can.
      const activeTurn = answering(answer as ActiveTurnAnswer);
      const { transport } = setup([], { activeTurn });

      await expect(transport.reconnectToStream({ chatId: 'chat-1' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });

    it('rejects with SessionHistoryFetchFailed when it rejects with anything but an Ably error, and logs it', async () => {
      const { logger, errors } = recordingLogger();
      const activeTurn = vi.fn<ActiveTurnFn>().mockRejectedValue(new SyntaxError('Unexpected token <'));
      const { transport } = setup([], { logger, activeTurn });

      await expect(transport.reconnectToStream({ chatId: 'chat-1' })).rejects.toBeErrorInfo({
        code: ErrorCode.SessionHistoryFetchFailed,
        statusCode: 500,
        message: 'unable to reconnect to stream; activeTurn rejected: Unexpected token <',
      });
      expect(errors).toEqual(['ChatTransport.reconnectToStream(); activeTurn rejected']);
    });

    it('passes an Ably error it rejects with on unchanged', async () => {
      const failure = new Ably.ErrorInfo('unable to look up the turn; the backend is down', 50000, 500);
      const { transport } = setup([], { activeTurn: vi.fn<ActiveTurnFn>().mockRejectedValue(failure) });

      await expect(transport.reconnectToStream({ chatId: 'chat-1' })).rejects.toBe(failure);
    });

    it('does not ask it when the signal has already fired', async () => {
      const activeTurn = answering({});
      const { transport } = setup(running.stored, { activeTurn });
      const controller = new AbortController();
      controller.abort();

      await expect(
        transport.reconnectToStream({ chatId: 'chat-1', abortSignal: controller.signal }),
      ).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
      expect(activeTurn).not.toHaveBeenCalled();
    });

    it('rejects with OperationCancelled, without calling onStop, when stopped while it is asked', async () => {
      const onStop = vi.fn();
      const pending = Promise.withResolvers<ActiveTurnAnswer>();
      const { transport } = setup([], { onStop, activeTurn: vi.fn<ActiveTurnFn>().mockReturnValue(pending.promise) });
      const controller = new AbortController();

      const reconnecting = transport.reconnectToStream({ chatId: 'chat-1', abortSignal: controller.signal });
      controller.abort();

      await expect(reconnecting).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
      await expect(reconnecting).rejects.toHaveProperty('name', 'AbortError');
      await nextMacrotask();
      expect(onStop).not.toHaveBeenCalled();
    });

    it.each([
      ['{}', {}],
      ['null', NOTHING_RUNNING],
    ])('resolves null when the transport closes while it is asked, and it answers %s', async (_label, answer) => {
      const pending = Promise.withResolvers<ActiveTurnAnswer>();
      const { transport } = setup(running.stored, {
        activeTurn: vi.fn<ActiveTurnFn>().mockReturnValue(pending.promise),
      });

      const reconnecting = transport.reconnectToStream({ chatId: 'chat-1' });
      transport.close();
      pending.resolve(answer);

      expect(await reconnecting).toBeNull();
    });
  });

  it('rejects with OperationCancelled, without calling onStop, when stopped while it reads the channel', async () => {
    const onStop = vi.fn();
    const { transport } = setup(running.stored, { onStop });
    const controller = new AbortController();

    const reconnecting = transport.reconnectToStream({ chatId: 'chat-1', abortSignal: controller.signal });
    controller.abort();

    await expect(reconnecting).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await nextMacrotask();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('resolves null, leaving the channel unread, when the transport closes while it opens the channel', async () => {
    const { transport, fixture } = setup(running.stored);

    const reconnecting = transport.reconnectToStream({ chatId: 'chat-1' });
    transport.close();

    expect(await reconnecting).toBeNull();
    await nextMacrotask();
    expect(fixture.channel.subscribe).not.toHaveBeenCalled();
  });

  it('ends the stream with OperationCancelled when stopped after it rejoined, then calls onStop', async () => {
    const onStop = vi.fn();
    const { transport, fixture } = setup(running.stored, { onStop });
    const controller = new AbortController();
    const stream = await transport.reconnectToStream({ chatId: 'chat-1', abortSignal: controller.signal });

    controller.abort();
    await flushMicrotasks();

    expect(onStop).toHaveBeenCalledWith({ chatId: 'chat-1', channel: fixture.channel });
    const read = drain(stream);
    await expect(read).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await expect(read).rejects.toHaveProperty('name', 'AbortError');
  });

  it('keeps an abort just before it, with no await between, from calling onStop, as useChat replacing a resumed reply does', async () => {
    const onStop = vi.fn();
    const { transport, fixture } = setup(running.stored, { onStop });
    const controller = new AbortController();
    const first = await transport.reconnectToStream({ chatId: 'chat-1', abortSignal: controller.signal });

    controller.abort();
    const again = transport.reconnectToStream({ chatId: 'chat-1' });
    const second = await again;
    fixture.deliver(running.live);

    expect(onStop).not.toHaveBeenCalled();
    await expect(drain(first)).rejects.toHaveProperty('name', 'AbortError');
    expect(await drain(second)).toEqual(reply);
  });

  it('rejects with SessionSubscriptionFailed when the channel cannot be attached', async () => {
    const { transport, fixture } = setup();
    fixture.channel.attach.mockRejectedValue(new Ably.ErrorInfo('channel failed', 90000, 400));

    await expect(transport.reconnectToStream({ chatId: 'chat-1' })).rejects.toBeErrorInfo({
      code: ErrorCode.SessionSubscriptionFailed,
      cause: { message: 'channel failed' },
    });
  });
});
