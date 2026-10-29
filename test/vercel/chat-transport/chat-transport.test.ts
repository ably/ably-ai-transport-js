import * as Ably from '@ably/pubsub-core';
import type * as AI from 'ai';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { type Logger, LogLevel, makeLogger } from '../../../src/logger.js';
import { type AblyChatTransport, type ChatTransportOptions, createChatTransport } from '../../../src/vercel/index.js';
import { drain, flushMicrotasks, nextMacrotask } from '../../helper/streams.js';
import {
  type ChannelFixture,
  channelWith,
  failedToStart,
  gate,
  paginated,
  textTurn,
  wireAcross,
  wireOf,
} from './fixtures.js';

type SendMessagesOptions = Parameters<AblyChatTransport['sendMessages']>[0];

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
 * @param options - Options beyond the channel.
 * @returns The transport and its channel.
 */
const setup = (
  stored: Ably.InboundMessage[] = [],
  options: Partial<ChatTransportOptions> = {},
): { transport: AblyChatTransport; fixture: ChannelFixture } => {
  const fixture = channelWith(stored);
  const transport = createChatTransport({ channel: fixture.channel, ...options });
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
  it('declares that a resumed stream replays its turn from the start', () => {
    const { transport } = setup();
    expect(transport.resumeStreamIsReplay).toBe(true);
  });

  it('leaves the channel alone until its first call', () => {
    const { fixture } = setup();

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

  it('posts at once while the latest turn is still running, and streams the next turn alone', async () => {
    const running = textTurn('t0', ['Old', ' text'], 'abort');
    const wire = wireAcross(running.slice(0, 3), [...running.slice(3), ...reply]);
    const tail = wire.live.slice(0, running.length - 3);
    const { transport, fixture } = setup(wire.stored);

    const stream = await transport.sendMessages(sendOptions());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The backend starts the new turn once the running one has ended.
    fixture.deliver(tail);
    fixture.deliver(wire.live.slice(tail.length));

    expect(await drain(stream)).toEqual(reply);
  });

  it('mixes the running turn into the next one when the next starts before it has ended', async () => {
    const running = textTurn('t0', ['Old', ' text'], 'abort');
    const late = running.slice(3);
    const wire = wireAcross(running.slice(0, 3), [...reply.slice(0, 2), ...late]);
    const { transport, fixture } = setup(wire.stored);
    const stream = await transport.sendMessages(sendOptions());

    // The backend started the next turn while the running one still wrote.
    fixture.deliver(wire.live);

    expect(await drain(stream)).toEqual([...reply.slice(0, 2), ...late]);
  });

  it('posts nothing after close(), however soon after the channel is read it lands', async () => {
    // close() lands from 0 to 29 microtasks after history arrives: before
    // the post, which it stops, or after it.
    for (let hops = 0; hops < 30; hops += 1) {
      const { transport, fixture } = setup();
      const page = Promise.withResolvers<Ably.PaginatedResult<Ably.InboundMessage>>();
      fixture.channel.history.mockReturnValueOnce(page.promise);
      fetchMock.mockClear();
      const closed = vi.fn();
      const sending = transport.sendMessages(sendOptions());
      await nextMacrotask();

      page.resolve(paginated([]));
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
    const { transport } = setup();
    const controller = new AbortController();

    const sending = transport.sendMessages(sendOptions({ abortSignal: controller.signal }));
    controller.abort();

    await expect(sending).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await expect(sending).rejects.toHaveProperty('name', 'AbortError');
    await nextMacrotask();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends the stream with OperationCancelled, named AbortError, when stopped mid-reply, and aborts its request', async () => {
    const { transport, fixture } = setup();
    const controller = new AbortController();
    const stream = await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));
    const wire = wireOf(reply).live;
    fixture.deliver(wire.slice(0, 2));

    controller.abort();
    fixture.deliver(wire.slice(2));

    expect(posted().init.signal?.aborted).toBe(true);
    const read = stream.getReader().read();
    await expect(read).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await expect(read).rejects.toHaveProperty('name', 'AbortError');
  });

  it('rejects with the attach’s own code when the channel cannot be attached, and tries again on the next call', async () => {
    const { transport, fixture } = setup();
    fixture.channel.attach.mockRejectedValue(new Ably.ErrorInfo('channel failed', 90000, 400));

    await expect(transport.sendMessages(sendOptions())).rejects.toBeErrorInfo({
      code: 90000,
      cause: { message: 'channel failed' },
    });

    fixture.channel.attach.mockReset();
    const stream = await transport.sendMessages(sendOptions());
    fixture.deliver(wireOf(reply).live);
    expect(await drain(stream)).toEqual(reply);
  });
});

describe('close', () => {
  it('ends a reply still streaming as a stop for useChat, then detaches the channel', async () => {
    const { transport, fixture } = setup();
    const controller = new AbortController();
    const stream = await transport.sendMessages(sendOptions({ abortSignal: controller.signal }));

    transport.close();
    // useChat's own stop, after the transport's close, stops nothing more.
    controller.abort();
    await nextMacrotask();

    await expect(drain(stream)).rejects.toHaveProperty('name', 'AbortError');
    expect(fixture.channel.listener).toBeUndefined();
    expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
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

    const transport = createChatTransport({ channel: fixture.channel });
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
    await transport.sendMessages(sendOptions());
    transport.close();
    await transport.sendMessages(sendOptions());

    await transport.sendMessages(sendOptions());

    expect(fixture.channel.subscribe).toHaveBeenCalledTimes(2);
    expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
  });

  it('keeps the read it opens after continuity was lost, through the detach and the attach that make that read', async () => {
    const { transport, fixture } = setup();
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
    page.resolve(paginated([]));

    await expect(sending).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    await nextMacrotask();
    expect(errors).toEqual([]);
  });

  it('never detaches a channel the application attached, even one it first found SUSPENDED', async () => {
    const { transport, fixture } = setup();
    fixture.channel.state = 'suspended';
    fixture.channel.attach.mockRejectedValueOnce(new Ably.PartialErrorInfo('connection suspended', 80002, 400));

    await expect(transport.sendMessages(sendOptions())).rejects.toBeErrorInfo({ code: 80002, statusCode: 400 });
    // ably-js re-attaches the application's channel once the connection is back.
    fixture.channel.state = 'attached';
    await transport.sendMessages(sendOptions());
    transport.close();
    await nextMacrotask();

    expect(fixture.channel.listener).toBeUndefined();
    expect(fixture.channel.detach).not.toHaveBeenCalled();
  });

  it('does nothing when the transport has not read the channel, and is safe to call twice', async () => {
    const { transport, fixture } = setup();

    transport.close();
    transport.close();
    await nextMacrotask();

    expect(fixture.channel.detach).not.toHaveBeenCalled();
  });
});
