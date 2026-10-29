/**
 * The chat transport driven by the AI SDK's own chat: `AbstractChat`, the
 * class every framework's `useChat` builds on, with the state the frameworks
 * keep reduced to a plain list. These run the AI SDK's real reducer and its
 * real stop and resume logic against the transport.
 */

import type * as Ably from 'ably';
// A named import for `ChatState` in the `implements` clause: `import-x/namespace`
// cannot verify a namespaced generic there, though tsc resolves it.
import type { ChatState } from 'ai';
import * as AI from 'ai';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { type AblyChatTransport, type ChatTransportOptions, createChatTransport } from '../../../src/vercel/index.js';
import { nextMacrotask } from '../../helper/streams.js';
import {
  type ChannelFixture,
  channelWith,
  failedToStart,
  failedTurn,
  textTurn,
  wireAcross,
  wireOf,
} from './fixtures.js';

/**
 * A chat's state as a plain list, with a way to wait for a change to it. Like
 * React's, it stores a copy of a message it replaces.
 */
class ListState implements ChatState<AI.UIMessage> {
  status: AI.ChatStatus = 'ready';
  error: Error | undefined = undefined;
  messages: AI.UIMessage[];
  private readonly _waiting = new Set<() => void>();

  constructor(messages: AI.UIMessage[] = []) {
    this.messages = messages;
  }

  pushMessage(message: AI.UIMessage): void {
    this.messages = [...this.messages, message];
    this._changed();
  }

  popMessage(): void {
    this.messages = this.messages.slice(0, -1);
    this._changed();
  }

  replaceMessage(index: number, message: AI.UIMessage): void {
    this.messages = this.messages.with(index, this.snapshot(message));
    this._changed();
  }

  snapshot<T>(thing: T): T {
    return structuredClone(thing);
  }

  /**
   * Resolve once the messages satisfy `predicate`.
   * @param predicate - The condition.
   * @returns Resolves when it holds.
   */
  async until(predicate: (messages: AI.UIMessage[]) => boolean): Promise<void> {
    if (predicate(this.messages)) return;
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (!predicate(this.messages)) return;
        this._waiting.delete(check);
        resolve();
      };
      this._waiting.add(check);
    });
  }

  private _changed(): void {
    for (const check of this._waiting) check();
  }
}

/** The AI SDK's chat, as a framework's `useChat` builds it. */
class TestChat extends AI.AbstractChat<AI.UIMessage> {}

/**
 * The text of a message's text parts, joined.
 * @param message - The message.
 * @returns The text.
 */
const textOf = (message: AI.UIMessage | undefined): string =>
  (message?.parts ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');

const reply = textTurn('t1', ['Hel', 'lo']);

let fetchMock: Mock<typeof fetch>;
/** Who is waiting for the transport's next post, in order. */
let waitingForPost: (() => void)[];

/**
 * Resolves once the transport has posted its next turn.
 * @returns Resolves on the next post.
 */
const nextPost = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    waitingForPost.push(resolve);
  });
};

beforeEach(() => {
  waitingForPost = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
  fetchMock = vi.fn<typeof fetch>(async () => {
    waitingForPost.shift()?.();
    return new Response(undefined, { status: 204 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A chat on the chat transport, and what the test drives it with. */
interface ChatFixture {
  /** The chat. */
  chat: TestChat;
  /** Its state. */
  state: ListState;
  /** The transport under it. */
  transport: AblyChatTransport;
  /** The channel the transport reads. */
  fixture: ChannelFixture;
  /** The chat's `onError`. */
  onError: Mock<(error: Error) => void>;
}

/**
 * A chat on a transport over a mock channel whose history holds `stored`.
 * @param options - The channel's history, the chat's messages and callbacks, and transport options.
 * @param options.stored - What history holds.
 * @param options.messages - The messages the chat starts with.
 * @param options.transport - Options beyond the client and channel name.
 * @param options.onError - The chat's `onError`.
 * @param options.sendAutomaticallyWhen - The chat's `sendAutomaticallyWhen`.
 * @returns The chat and what drives it.
 */
const chatOn = ({
  stored = [],
  messages = [],
  transport: transportOptions = {},
  onError = vi.fn<(error: Error) => void>(),
  sendAutomaticallyWhen,
}: {
  stored?: Ably.InboundMessage[];
  messages?: AI.UIMessage[];
  transport?: Partial<ChatTransportOptions>;
  onError?: Mock<(error: Error) => void>;
  sendAutomaticallyWhen?: (options: { messages: AI.UIMessage[] }) => boolean;
} = {}): ChatFixture => {
  const fixture = channelWith(stored);
  const state = new ListState(messages);
  const transport = createChatTransport({ client: fixture.client, channelName: 'chat', ...transportOptions });
  const chat = new TestChat({ id: 'chat-1', transport, state, onError, sendAutomaticallyWhen });
  return { chat, state, transport, fixture, onError };
};

describe('the chat transport under the AI SDK’s chat', () => {
  it('turns a sent prompt and its reply into two messages', async () => {
    const { chat, state, fixture } = chatOn();
    const posted = nextPost();

    const sending = chat.sendMessage({ text: 'Hello?' });
    await posted;
    fixture.deliver(wireOf(reply).live);
    await sending;

    expect(state.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(textOf(state.messages[1])).toBe('Hello');
    expect(chat.status).toBe('ready');
  });

  it('posts a tool’s output as the next turn, whose reply continues the same assistant message', async () => {
    const toolCall: AI.UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'weather', input: { city: 'London' } },
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    const answer: AI.UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      ...textTurn('t2', ['Sunny']).slice(1, -1),
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    const wire = wireOf([...toolCall, ...answer]).live;
    const { chat, state, fixture } = chatOn({ sendAutomaticallyWhen: AI.lastAssistantMessageIsCompleteWithToolCalls });
    const firstPost = nextPost();

    const sending = chat.sendMessage({ text: 'Weather in London?' });
    await firstPost;
    fixture.deliver(wire.slice(0, toolCall.length));
    await sending;
    const secondPost = nextPost();
    await chat.addToolOutput({ tool: 'weather', toolCallId: 'call-1', output: { forecast: 'sunny' } });
    await secondPost;
    fixture.deliver(wire.slice(toolCall.length));
    await state.until((messages) => textOf(messages[1]) === 'Sunny');

    expect(state.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(state.messages[1]?.parts).toContainEqual(
      expect.objectContaining({ type: 'tool-weather', state: 'output-available', output: { forecast: 'sunny' } }),
    );
    // CAST: the transport posts a JSON string.
    const continued = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as { messages: AI.UIMessage[] };
    expect(continued.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: 'tool-weather', state: 'output-available' }),
    );
  });

  it('shows an agent that failed before streaming as the chat’s error', async () => {
    const { chat, fixture } = chatOn();
    const posted = nextPost();

    const sending = chat.sendMessage({ text: 'Hello?' });
    await posted;
    fixture.deliver(wireOf([failedToStart]).live);
    await sending;

    expect(chat.status).toBe('error');
    expect(chat.error?.message).toBe('the agent failed to start');
  });

  it('shows a failed post as the chat’s error, with SessionSendFailed', async () => {
    fetchMock.mockResolvedValue(new Response('the agent is down', { status: 503 }));
    const { chat } = chatOn();

    await chat.sendMessage({ text: 'Hello?' });

    expect(chat.status).toBe('error');
    expect(chat.error).toBeErrorInfo({ code: ErrorCode.SessionSendFailed, statusCode: 503 });
  });

  it('calls onStop once on stop(), and keeps the text that arrived', async () => {
    const onStop = vi.fn();
    const { chat, state, fixture } = chatOn({ transport: { onStop } });
    const posted = nextPost();
    const wire = wireOf(reply).live;

    const sending = chat.sendMessage({ text: 'Hello?' });
    await posted;
    fixture.deliver(wire.slice(0, 3));
    await state.until((messages) => textOf(messages[1]) === 'Hel');
    await chat.stop();
    await sending;
    fixture.deliver(wire.slice(3));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(textOf(state.messages[1])).toBe('Hel');
    expect(chat.status).toBe('ready');
  });

  it.each([
    ['the chat stops, then the transport closes', 'stop first'],
    ['the transport closes, then the chat stops', 'close first'],
  ])('leaves the agent running when %s with no await between, as on unmount', async (_label, order) => {
    const onStop = vi.fn();
    const { chat, state, transport, fixture, onError } = chatOn({ transport: { onStop } });
    const posted = nextPost();

    const sending = chat.sendMessage({ text: 'Hello?' });
    await posted;
    fixture.deliver(wireOf(reply).live.slice(0, 3));
    await state.until((messages) => textOf(messages[1]) === 'Hel');
    if (order === 'close first') transport.close();
    const stopping = chat.stop();
    if (order === 'stop first') transport.close();
    await stopping;
    await sending;
    await nextMacrotask();

    expect(onStop).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(chat.status).toBe('ready');
    expect(textOf(state.messages[1])).toBe('Hel');
  });

  it('calls onStop when the chat is disposed mid-reply, since dispose() stops before it closes', async (context) => {
    const onStop = vi.fn();
    const { chat, state, fixture } = chatOn({ transport: { onStop } });
    // `dispose()` arrived in ai 7.0.135; ai 6 has none.
    const dispose: unknown = Reflect.get(chat, 'dispose');
    if (typeof dispose !== 'function') {
      context.skip();
      return;
    }
    const posted = nextPost();

    const sending = chat.sendMessage({ text: 'Hello?' });
    await posted;
    fixture.deliver(wireOf(reply).live.slice(0, 3));
    await state.until((messages) => textOf(messages[1]) === 'Hel');
    await Reflect.apply(dispose, chat, []);
    await sending;
    await nextMacrotask();

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(fixture.channel.listener).toBeUndefined();
  });

  it('reads a close() mid-reply as a stop, without calling onStop', async () => {
    const onStop = vi.fn();
    const { chat, state, transport, fixture, onError } = chatOn({ transport: { onStop } });
    const posted = nextPost();

    const sending = chat.sendMessage({ text: 'Hello?' });
    await posted;
    fixture.deliver(wireOf(reply).live.slice(0, 3));
    await state.until((messages) => textOf(messages[1]) === 'Hel');
    transport.close();
    await sending;
    await nextMacrotask();

    expect(onStop).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(chat.status).toBe('ready');
    expect(textOf(state.messages[1])).toBe('Hel');
  });

  it('rejoins a running turn as a fresh message, leaving the previous reply alone', async () => {
    const running = wireAcross(reply.slice(0, 3), reply.slice(3));
    const earlier: AI.UIMessage[] = [
      { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
      { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'Hi there' }] },
    ];
    const { chat, state, fixture } = chatOn({ stored: running.stored, messages: earlier });

    const resuming = chat.resumeStream();
    await state.until((messages) => messages.length === 3);
    fixture.deliver(running.live);
    await resuming;

    expect(state.messages.map((message) => textOf(message))).toEqual(['Hi', 'Hi there', 'Hello']);
    expect(chat.status).toBe('ready');
  });

  it('leaves a running turn alone when a resume is stopped while it looks, then rejoins on the next one', async () => {
    const onStop = vi.fn();
    const running = wireAcross(reply.slice(0, 3), reply.slice(3));
    const { chat, state, fixture } = chatOn({ stored: running.stored, transport: { onStop } });

    // A StrictMode mount: resume, unmount (which stops), mount again.
    const first = chat.resumeStream();
    await chat.stop();
    await first;
    const second = chat.resumeStream();
    await state.until((messages) => messages.length === 1);
    fixture.deliver(running.live);
    await second;

    expect(onStop).not.toHaveBeenCalled();
    expect(textOf(state.messages[0])).toBe('Hello');
  });

  it('leaves the chat ready, with no error, when the transport closes while a resume looks', async () => {
    const running = wireAcross(reply.slice(0, 3), reply.slice(3));
    const { chat, transport, onError } = chatOn({ stored: running.stored });

    const resuming = chat.resumeStream();
    transport.close();
    await resuming;

    expect(onError).not.toHaveBeenCalled();
    expect(chat.status).toBe('ready');
  });

  it('does not call onStop when the chat replaces a reply it resumed with another resume', async () => {
    const onStop = vi.fn();
    const running = wireAcross(reply.slice(0, 3), reply.slice(3));
    const { chat, state, fixture } = chatOn({ stored: running.stored, transport: { onStop } });

    const first = chat.resumeStream();
    await state.until((messages) => textOf(messages[0]) === 'Hel');
    const second = chat.resumeStream();
    await first;
    fixture.deliver(running.live);
    await second;
    await nextMacrotask();

    expect(onStop).not.toHaveBeenCalled();
    expect(chat.status).toBe('ready');
  });

  it('regenerates straight after a stop once the stopped turn has ended, without its tail', async () => {
    const { chat, state, fixture } = chatOn({ transport: { onStop: vi.fn() } });
    const stopped = textTurn('t1', ['Hel', 'lo'], 'abort');
    const again = textTurn('t2', ['Bye']);
    const wire = wireOf([...stopped, ...again]).live;
    const firstPost = nextPost();

    const sending = chat.sendMessage({ text: 'Hello?' });
    await firstPost;
    fixture.deliver(wire.slice(0, 3));
    await state.until((messages) => textOf(messages[1]) === 'Hel');
    await chat.stop();
    await sending;

    const secondPost = nextPost();
    const regenerating = chat.regenerate();
    await nextMacrotask();
    // The stopped agent has not published its last chunks yet, so the next
    // turn waits for them.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fixture.deliver(wire.slice(3, stopped.length));
    await secondPost;
    fixture.deliver(wire.slice(stopped.length));
    await regenerating;

    expect(state.messages.map((message) => textOf(message))).toEqual(['Hello?', 'Bye']);
    expect(chat.status).toBe('ready');
  });

  it('retries from onError without losing the retried turn to the finish the AI SDK writes after an error', async () => {
    const errored = failedTurn('t1', 'Hel');
    const retried = textTurn('t2', ['Bye']);
    const wire = wireOf([...errored, ...retried]).live;
    const retrying: { chat?: TestChat; retry?: Promise<void> } = {};
    const { chat, state, fixture } = chatOn({
      onError: vi.fn<(error: Error) => void>(() => {
        retrying.retry ??= retrying.chat?.regenerate();
      }),
    });
    retrying.chat = chat;
    const firstPost = nextPost();

    const sending = chat.sendMessage({ text: 'Hello?' });
    await firstPost;
    const secondPost = nextPost();
    fixture.deliver(wire.slice(0, 4));
    await nextMacrotask();
    // The retry waits for the finish the AI SDK writes after the error.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fixture.deliver(wire.slice(4, errored.length));
    await secondPost;
    fixture.deliver(wire.slice(errored.length));
    await sending;
    await retrying.retry;

    expect(state.messages.map((message) => textOf(message))).toEqual(['Hello?', 'Bye']);
    expect(chat.status).toBe('ready');
  });

  it('sends after a stop that came before the reply started once the stopped agent’s turn has ended', async () => {
    const { chat, state, fixture } = chatOn({ transport: { onStop: vi.fn() } });
    const missedCancel = textTurn('t1', ['Old']);
    const next = textTurn('t2', ['Bye']);
    const wire = wireOf([...missedCancel, ...next]).live;
    const firstPost = nextPost();

    const sending = chat.sendMessage({ text: 'Hello?' });
    await firstPost;
    await chat.stop();
    await sending;
    // The agent missed the cancel, and its turn starts anyway.
    fixture.deliver(wire.slice(0, 3));
    const secondPost = nextPost();
    const resending = chat.sendMessage({ text: 'Say bye' });
    await nextMacrotask();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fixture.deliver(wire.slice(3, missedCancel.length));
    await secondPost;
    fixture.deliver(wire.slice(missedCancel.length));
    await resending;

    expect(state.messages.map((message) => textOf(message))).toEqual(['Hello?', 'Say bye', 'Bye']);
    expect(chat.status).toBe('ready');
  });

  it('ends a reply whose turn the next one cuts short, without mixing the two', async () => {
    const dead: AI.UIMessageChunk[] = [
      { type: 'start', messageId: 'm1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hel' },
    ];
    const next: AI.UIMessageChunk[] = [
      { type: 'start', messageId: 'm2' },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: 'Bye' },
      { type: 'text-end', id: 't2' },
      { type: 'finish' },
    ];
    const { chat, state, fixture } = chatOn();
    const posted = nextPost();

    const sending = chat.sendMessage({ text: 'Hello?' });
    await posted;
    fixture.deliver(wireOf([...dead, ...next]).live);
    await sending;

    expect(state.messages.map((message) => textOf(message))).toEqual(['Hello?', 'Hel']);
    expect(chat.status).toBe('ready');
  });
});
